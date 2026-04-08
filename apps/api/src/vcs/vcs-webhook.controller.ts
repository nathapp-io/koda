import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '@nathapp/nestjs-auth';
import { AuthException } from '@nathapp/nestjs-common';
import { ProjectsService } from '../projects/projects.service';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';

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
    @Headers('x-github-event') githubEvent?: string,
  ): Promise<{ ignored?: boolean; success: boolean; reason?: string }> {
    const project = await this.projectsService.findBySlug(slug);
    const connection = await this.vcsConnectionService.getFullByProject(project.id);

    const isValid = this.webhookService.verifySignature(
      JSON.stringify(payload),
      signature || '',
      connection.webhookSecret || '',
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
