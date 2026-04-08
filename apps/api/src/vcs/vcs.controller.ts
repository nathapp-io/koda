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
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { ConfigService } from '@nestjs/config';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { Project } from '@prisma/client';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { ProjectsService } from '../projects/projects.service';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import { VcsConnectionResponseDto } from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { decryptToken } from '../common/utils/encryption.util';
import { createVcsProvider } from './factory';

@ApiTags('vcs')
@ApiBearerAuth()
@Controller('/projects/:slug/vcs')
export class VcsController {
  constructor(
    private readonly vcsService: VcsConnectionService,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    private readonly projectsService: ProjectsService,
    private readonly configService: ConfigService,
  ) {}

  private throwEncryptionKeyNotConfigured(): never {
    throw new ValidationAppException({}, 'vcs');
  }

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
      this.throwEncryptionKeyNotConfigured();
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
      this.throwEncryptionKeyNotConfigured();
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
      this.throwEncryptionKeyNotConfigured();
    }

    return this.vcsService.testConnection(project.id, encryptionKey);
  }

  /**
   * POST /projects/:slug/vcs/sync/:issueNumber
   * Manually sync a specific issue
   */
  @Post('/sync/:issueNumber')
  @ApiOperation({ summary: 'Manually sync a specific issue by number' })
  @ApiResponse({ status: 200, description: 'Issue synced successfully', type: SyncResultDto })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  @ApiResponse({ status: 409, description: 'Issue already synced (externalVcsId exists)' })
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
      this.throwEncryptionKeyNotConfigured();
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

    // Return HTTP 409 if issue is already synced
    if (result.action === 'skipped') {
      throw new ValidationAppException({}, 'vcs');
    }

    const ref = result.ticketNumber ? `${project.key}-${result.ticketNumber}` : undefined;

    return {
      syncType: 'manual',
      issuesSynced: 1,
      issuesSkipped: 0,
      tickets:
        ref
          ? [
              {
                ref,
                title: issue.title,
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
  @ApiOperation({ summary: 'Trigger a full sync of all issues from the VCS provider' })
  @ApiResponse({ status: 200, description: 'Full sync completed', type: SyncResultDto })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async syncAll(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<SyncResultDto> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Run full sync
    const result = await this.syncService.fullSync(project as Project, connection, encryptionKey);

    return {
      syncType: 'manual',
      issuesSynced: result.issuesSynced,
      issuesSkipped: result.issuesSkipped,
      tickets: result.createdTickets.map((ticket) => ({
        ref: `${project.key}-${ticket.number}`,
        title: ticket.title,
      })),
    };
  }

  /**
   * POST /projects/:slug/vcs/sync-pr
   * Trigger manual PR status sync for all active PRs
   */
  @Post('/sync-pr')
  @ApiOperation({ summary: 'Manually sync PR status for all active pull requests' })
  @ApiResponse({ status: 200, description: 'PR sync completed', type: Object })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async syncPr(
    @Param('slug') slug: string,
    @Principal('userId') userId?: string,
  ): Promise<{ updated: number }> {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Run PR sync
    const result = await this.prSyncService.syncPrStatus(project as Project, connection, encryptionKey);

    return { updated: result.updated };
  }
}
