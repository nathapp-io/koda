import { Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload, WebhookHandleResult } from './vcs-webhook.service';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import { InboundWebhookRequest, signedBytesOf } from '../webhook-security/inbound-webhook-request';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';

@ApiTags('vcs')
@Controller()
export class VcsWebhookController {
  constructor(
    private readonly vcsConnectionService: VcsConnectionService,
    private readonly webhookService: VcsWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
  ) {}

  @Post('/projects/:slug/vcs-webhook')
  @HttpCode(HttpStatus.OK)
  @Public()
  @ApiOperation({ summary: 'Receive GitHub VCS issue webhook' })
  @ApiResponse({
    status: 200,
    description: 'Webhook processed, or ignored because the connection is inactive or not in webhook sync mode',
  })
  @ApiResponse({ status: 401, description: 'Unknown project, no VCS connection or webhook secret, or invalid signature' })
  async handleWebhook(
    @Param('slug') slug: string,
    @Headers('x-hub-signature-256') signature: string,
    @Req() request: InboundWebhookRequest,
    @Headers('x-github-event') githubEvent?: string,
    @Headers('x-github-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
  ): Promise<WebhookHandleResult> {
    // One lookup. An unknown slug, a missing connection or secret, and a bad
    // signature all get the same 401, so the route does not reveal which slugs
    // exist or which projects have a VCS connection.
    const connection = await this.vcsConnectionService.findInboundTarget(slug);
    if (
      !connection?.webhookSecret ||
      !this.webhookService.verifySignature(signedBytesOf(request), signature || '', connection.webhookSecret)
    ) {
      throw new AuthException({}, 'vcs_webhook');
    }

    // After the signature, so an unsigned caller cannot learn the connection
    // state. 200, not 4xx: GitHub retries non-2xx deliveries.
    const ignoreReason = this.ignoreReasonFor(connection);
    if (ignoreReason) {
      return { success: true, ignored: true, reason: ignoreReason };
    }

    const payload = (request.body !== null && typeof request.body === 'object' ? request.body : {}) as GitHubWebhookPayload;

    // SEC-1: reject replayed deliveries; forget on failure so GitHub's retry
    // with the same X-GitHub-Delivery id is accepted.
    await this.replayGuard.assertFresh({ projectId: connection.projectId, source: 'github', deliveryId, dateHeader });

    const eventType = githubEvent
      || (payload.pull_request ? 'pull_request' : payload.issue ? 'issues' : 'unknown');
    const event = eventType === 'issues'
      ? `issues.${payload.action || 'unknown'}`
      : eventType;

    try {
      return await this.webhookService.handleWebhook(connection, event, payload);
    } catch (err) {
      await this.replayGuard.forget({ projectId: connection.projectId, source: 'github', deliveryId });
      throw err;
    }
  }

  private ignoreReasonFor(connection: VcsConnectionWithProjectDomain): string | null {
    if (!connection.isActive) {
      return 'VCS connection is inactive';
    }
    if (connection.syncMode !== 'webhook') {
      return `VCS connection syncMode is '${connection.syncMode}'; webhook deliveries are processed only in 'webhook' mode`;
    }
    return null;
  }
}
