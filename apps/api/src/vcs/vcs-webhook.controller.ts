import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { ProjectsService } from '../projects/projects.service';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';

type RawBodyRequest = { rawBody?: Buffer };

@ApiTags('vcs')
@Controller()
export class VcsWebhookController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly vcsConnectionService: VcsConnectionService,
    private readonly webhookService: VcsWebhookService,
  ) {}

  @Post('/projects/:slug/vcs-webhook')
  @HttpCode(HttpStatus.OK)
  @Public()
  @ApiOperation({ summary: 'Receive GitHub VCS issue webhook' })
  @ApiResponse({ status: 200, description: 'Webhook processed' })
  @ApiResponse({ status: 401, description: 'Invalid webhook signature' })
  async handleWebhook(
    @Param('slug') slug: string,
    @Headers('x-hub-signature-256') signature: string,
    @Body() payload: GitHubWebhookPayload,
    @Req() request: RawBodyRequest,
    @Headers('x-github-event') githubEvent?: string,
  ): Promise<{ ignored?: boolean; success: boolean; reason?: string }> {
    const project = await this.projectsService.findBySlug(slug);
    const connection = await this.vcsConnectionService.getFullByProject(project.id);

    if (!connection.webhookSecret) {
      throw new AuthException({}, 'vcs_webhook');
    }

    // GitHub HMACs the raw bytes. JSON.stringify of the parsed body is not
    // guaranteed to reproduce them, so verify against the raw body captured
    // by the preParsing hook in main.ts.
    const rawBody = request.rawBody;
    // Prefer the raw bytes captured by the Fastify preParsing hook (KODA-02).
    // Fall back to the re-serialized JSON when the hook is unavailable (e.g.
    // older test setups using Express, where the JSON body is round-tripped
    // by the platform anyway).
    const bodyBytes = rawBody ? rawBody.toString('utf8') : JSON.stringify(payload);

    const isValid = this.webhookService.verifySignature(
      bodyBytes,
      signature || '',
      connection.webhookSecret,
    );

    if (!isValid) {
      throw new AuthException({}, 'vcs_webhook');
    }

    const eventType = githubEvent
      || (payload.pull_request ? 'pull_request' : payload.issue ? 'issues' : 'unknown');
    const event = eventType === 'issues'
      ? `issues.${payload.action || 'unknown'}`
      : eventType;

    return this.webhookService.handleWebhook(
      { ...connection, project } as Parameters<typeof this.webhookService.handleWebhook>[0],
      event,
      payload,
    );
  }
}
