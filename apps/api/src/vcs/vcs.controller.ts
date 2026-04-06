import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  Headers,
} from '@nestjs/common';
import { Principal } from '@nathapp/nestjs-auth';
import { ConfigService } from '@nestjs/config';
import { AuthException } from '@nathapp/nestjs-common';
import { Project } from '@prisma/client';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsWebhookService, GitHubWebhookPayload } from './vcs-webhook.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';

@Controller('/projects/:slug/vcs')
export class VcsController {
  constructor(
    private readonly vcsService: VcsConnectionService,
    private readonly syncService: VcsSyncService,
    private readonly webhookService: VcsWebhookService,
    private readonly projectsService: ProjectsService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /projects/:slug/vcs
   * Create a new VCS connection for a project
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Param('slug') slug: string,
    @Body() dto: CreateVcsConnectionDto,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    return this.vcsService.create(project.id, encryptionKey, dto);
  }

  /**
   * GET /projects/:slug/vcs
   * Get VCS connection for a project
   */
  @Get()
  async getConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    return this.vcsService.findByProject(project.id);
  }

  /**
   * PATCH /projects/:slug/vcs
   * Update VCS connection for a project
   */
  @Patch()
  async updateConnection(
    @Param('slug') slug: string,
    @Body() dto: UpdateVcsConnectionDto,
    @Principal('userId') userId?: string,
  ): Promise<VcsConnectionResponseDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    return this.vcsService.update(project.id, encryptionKey, dto);
  }

  /**
   * DELETE /projects/:slug/vcs
   * Delete VCS connection for a project
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<void> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    return this.vcsService.delete(project.id);
  }

  /**
   * POST /projects/:slug/vcs/test
   * Test the VCS connection
   */
  @Post('/test')
  async testConnection(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<TestConnectionResultDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    const result = await this.vcsService.testConnection(project.id, encryptionKey);

    return {
      success: result.success,
      latencyMs: result.latencyMs,
      error: result.error,
    };
  }

  /**
   * POST /projects/:slug/vcs-webhook
   * Handle GitHub webhook events
   */
  @Post('/../vcs-webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('slug') slug: string,
    @Headers('x-hub-signature-256') signature: string,
    @Body() payload: GitHubWebhookPayload,
  ): Promise<{ success: boolean; ignored?: boolean; reason?: string }> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get VCS connection
    const connection = await this.vcsService.findByProject(project.id);

    // Verify signature (would need raw payload as string)
    // For now, skip verification - in production, middleware would handle this
    if (signature) {
      const isValid = this.webhookService.verifySignature(
        JSON.stringify(payload),
        signature,
        connection.webhookSecret || '',
      );

      if (!isValid) {
        throw new AuthException({}, 'vcs_webhook');
      }
    }

    // Get event type
    const event = payload.action || 'unknown';

    // Handle webhook
    const result = await this.webhookService.handleWebhook(
      { ...connection, project, id: connection.id } as Parameters<
        typeof this.webhookService.handleWebhook
      >[0],
      `issues.${event}`,
      payload,
    );

    return result;
  }

  /**
   * POST /projects/:slug/vcs/sync/:issueNumber
   * Manually sync a specific issue
   */
  @Post('/sync/:issueNumber')
  async syncIssue(
    @Param('slug') slug: string,
    @Param('issueNumber') issueNumber: string,
    @Principal('userId') userId?: string,
  ): Promise<SyncResultDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Decrypt token and create provider
    const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    const provider = createVcsProvider(connection.provider, {
      provider: connection.provider,
      token: decryptedToken,
      repoUrl: `https://github.com/${connection.repoOwner}/${connection.repoName}`,
    });

    // Fetch specific issue
    const issue = await provider.fetchIssue(parseInt(issueNumber, 10));

    // Sync the issue (regardless of allowedAuthors per AC)
    const result = await this.syncService.syncIssue(project as Project, issue, 'manual');

    return {
      issuesSynced: result.action === 'created' ? 1 : 0,
      issuesSkipped: result.action === 'skipped' ? 1 : 0,
      createdTickets:
        result.action === 'created' && result.ticketId && result.ticketNumber
          ? [
              {
                id: result.ticketId,
                projectKey: project.key,
                number: result.ticketNumber,
              },
            ]
          : [],
    };
  }

  /**
   * POST /projects/:slug/vcs/sync
   * Trigger full sync run
   */
  @Post('/sync')
  async syncAll(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<SyncResultDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      throw new Error('VCS encryption key not configured');
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Run full sync
    const result = await this.syncService.fullSync(project as Project, connection, encryptionKey);

    return {
      issuesSynced: result.issuesSynced,
      issuesSkipped: result.issuesSkipped,
      createdTickets: result.createdTickets.map((ticket) => ({
        id: ticket.id,
        projectKey: project.key,
        number: ticket.number,
      })),
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
  }
}
