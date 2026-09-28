import { Controller, Post, Param, HttpCode, Headers, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException, JsonResponse } from '@nathapp/nestjs-common';
import { CiWebhookService } from './ci-webhook.service';
import { CiWebhookPayloadDto, CiWebhookResponseDto } from './ci-webhook.dto';
import { WebhookReplayGuard } from '../webhook-security/webhook-replay.guard';
import {
  InboundWebhookRequest,
  parseInboundPayload,
  signedBytesOf,
} from '../webhook-security/inbound-webhook-request';
import { createHmac, timingSafeEqual } from 'node:crypto';

@ApiTags('ci-webhooks')
@Controller()
export class CiWebhookController {
  constructor(
    private ciWebhookService: CiWebhookService,
    private readonly replayGuard: WebhookReplayGuard,
  ) {}

  @Post('projects/:slug/ci-webhook')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Receive CI pipeline failure webhook and auto-create ticket' })
  @ApiBody({ type: CiWebhookPayloadDto })
  @ApiResponse({ status: 200, type: CiWebhookResponseDto, description: 'Webhook processed' })
  @ApiResponse({ status: 400, description: 'Invalid payload (checked only after a valid signature)' })
  @ApiResponse({ status: 401, description: 'Unknown project, no CI webhook token, or invalid signature' })
  async handleCiWebhook(
    @Param('slug') slug: string,
    @Req() request: InboundWebhookRequest,
    @Headers('x-ci-signature') signature?: string,
    @Headers('x-ci-delivery') deliveryId?: string,
    @Headers('date') dateHeader?: string,
  ) {
    // One lookup. An unknown slug, a missing token and a bad signature all get
    // the same 401, so the route does not reveal which slugs exist.
    const target = await this.ciWebhookService.findInboundTarget(slug);
    if (!target || !this.verifySignature(signedBytesOf(request), signature ?? '', target.secret)) {
      throw new AuthException({}, 'ci_webhook');
    }

    // Validate only after the signature, and before the replay record, so an
    // invalid delivery does not consume its id.
    const payload = await parseInboundPayload(CiWebhookPayloadDto, request.body);

    // SEC-1: reject replayed deliveries; forget on failure so the sender's
    // retry with the same delivery id is accepted.
    await this.replayGuard.assertFresh({ projectId: target.projectId, source: 'ci', deliveryId, dateHeader });

    try {
      const result = await this.ciWebhookService.processCiWebhook(slug, payload);
      return JsonResponse.Ok(result);
    } catch (err) {
      await this.replayGuard.forget({ projectId: target.projectId, source: 'ci', deliveryId });
      throw err;
    }
  }

  private verifySignature(payload: string, signature: string, secret: string): boolean {
    try {
      const expectedSignature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
      const expected = Buffer.from(expectedSignature);
      const received = Buffer.from(signature);

      if (expected.length !== received.length) {
        return false;
      }

      return timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }
}
