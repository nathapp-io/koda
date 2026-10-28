import { ApprovalGated } from '../approvals/route/approval-gated.decorator';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ApprovalPending } from '../approvals/route/approval-pending';
import { VCS_ROUTE_VARIANTS } from './vcs-route.commands';
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
  HttpException,
  Inject,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { VCS_CFG, IVcsConfig } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { ProjectsService } from '../projects/projects.service';
import { ProjectMembershipGuard } from '../projects/project-membership.guard';
import { CurrentProject } from '../projects/current-project.decorator';
import { ProjectContext } from '../projects/project-context';
import { Requires } from '../permissions/requires.decorator';
import { RequiresGuard } from '../permissions/requires.guard';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import {
  VcsConnectionResponseDto,
  VcsConnectionCreatedResponseDto,
  VcsConnectionUpdatedResponseDto,
  WebhookSecretResponseDto,
} from './dto/vcs-connection-response.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { decryptToken } from '../common/utils/encryption.util';
import { providerForConnection } from './provider-for-connection';

@ApiTags('vcs')
@ApiBearerAuth()
@Controller('/projects/:slug/vcs')
@UseGuards(ProjectMembershipGuard, RequiresGuard)
export class VcsController {
  constructor(
    private readonly vcsService: VcsConnectionService,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    private readonly projectsService: ProjectsService,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
    private readonly routeGate: ApprovalRouteGate,
  ) {}

  private throwEncryptionKeyNotConfigured(): never {
    throw new ValidationAppException({}, 'vcs');
  }

  /**
   * POST /projects/:slug/vcs
   * Create a new VCS connection for a project
   */
  @Post()
  @Requires('vcs.connection.create')
  @ApiOperation({ summary: 'Create a VCS connection for a project' })
  @ApiResponse({ status: 201, type: VcsConnectionCreatedResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.connection.create required' })
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Param('slug') slug: string,
    @Body() dto: CreateVcsConnectionDto,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.vcsConfig.encryptionKey;
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    return JsonResponse.Ok(await this.vcsService.create(project.id, encryptionKey, dto));
  }

  /**
   * GET /projects/:slug/vcs
   * Get VCS connection for a project
   */
  @Get()
  @Requires('vcs.connection.read')
  @ApiOperation({ summary: 'Get VCS connection for a project' })
  @ApiResponse({ status: 200, type: VcsConnectionResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.connection.read required' })
  async getConnection(
    @Param('slug') slug: string,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    return JsonResponse.Ok(await this.vcsService.findByProject(project.id));
  }

  /**
   * PATCH /projects/:slug/vcs
   * Update VCS connection for a project
   */
  @Patch()
  @Requires('vcs.connection.update')
  @ApiOperation({ summary: 'Update VCS connection for a project' })
  @ApiResponse({ status: 200, type: VcsConnectionUpdatedResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.connection.update required' })
  async updateConnection(
    @Param('slug') slug: string,
    @Body() dto: UpdateVcsConnectionDto,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.vcsConfig.encryptionKey;
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    return JsonResponse.Ok(await this.vcsService.update(project.id, encryptionKey, dto));
  }

  /**
   * DELETE /projects/:slug/vcs
   * Delete VCS connection for a project
   */
  @Delete()
  @Requires('vcs.connection.delete')
  @ApprovalGated()
  @ApiOperation({ summary: 'Delete VCS connection for a project' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.connection.delete required' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(
    @Param('slug') slug: string,
    @CurrentProject() ctx: ProjectContext,
  ): Promise<void> {
    const projectId = ctx.project.id;
    const outcome = await this.routeGate.run({
      key: 'vcs.connection.delete',
      variant: VCS_ROUTE_VARIANTS.delete,
      projectId,
      input: { projectId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return undefined;
  }

  /**
   * POST /projects/:slug/vcs/test
   * Test the VCS connection
   */
  @Post('/test')
  @Requires('vcs.connection.test')
  @ApprovalGated()
  @ApiOperation({ summary: 'Test the VCS connection for a project' })
  @ApiResponse({ status: 200, type: TestConnectionResultDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.connection.test required' })
  async testConnection(
    @Param('slug') slug: string,
    @CurrentProject() ctx: ProjectContext,
  ) {
    if (!this.vcsConfig.encryptionKey) this.throwEncryptionKeyNotConfigured();
    const projectId = ctx.project.id;
    const outcome = await this.routeGate.run<TestConnectionResultDto>({
      key: 'vcs.connection.test',
      variant: VCS_ROUTE_VARIANTS.test,
      projectId,
      input: { projectId },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(outcome.result);
  }

  /**
   * POST /projects/:slug/vcs/webhook-secret/rotate
   * Requires project access and `vcs.webhook-secret.rotate`, for users and agents alike.
   */
  @Post('/webhook-secret/rotate')
  @Requires('vcs.webhook-secret.rotate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate the VCS webhook secret and return the new secret once' })
  @ApiParam({ name: 'slug', required: true, schema: { type: 'string' } })
  @ApiResponse({ status: 200, type: WebhookSecretResponseDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.webhook-secret.rotate required' })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async rotateWebhookSecret(
    @CurrentProject() ctx: ProjectContext,
  ) {
    return JsonResponse.Ok(await this.vcsService.rotateWebhookSecret(ctx.project.id));
  }

  /**
   * POST /projects/:slug/vcs/sync/:issueNumber
   * Manually sync a specific issue
   */
  @Post('/sync/:issueNumber')
  @Requires('vcs.sync.issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually sync a specific issue by number' })
  @ApiResponse({ status: 200, description: 'Issue synced successfully', type: SyncResultDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.sync.issue required' })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  @ApiResponse({ status: 409, description: 'Issue already synced (externalVcsId exists)' })
  async syncIssue(
    @Param('slug') slug: string,
    @Param('issueNumber') issueNumber: string,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.vcsConfig.encryptionKey;
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Decrypt token and create provider
    const decryptedToken = decryptToken(connection.encryptedToken, encryptionKey);
    const provider = providerForConnection(connection, decryptedToken, this.vcsConfig);

    // Fetch specific issue
    const issue = await provider.fetchIssue(parseInt(issueNumber, 10));

    // Sync the issue (regardless of allowedAuthors per AC)
    const result = await this.syncService.syncIssue(project, issue, 'manual', connection, 'vcs.sync.issue');

    // Return HTTP 409 if issue is already synced
    if (result.action === 'skipped') {
      throw new HttpException('Issue already synced', HttpStatus.CONFLICT);
    }

    const ref = result.ticketNumber ? `${project.key}-${result.ticketNumber}` : undefined;

    return JsonResponse.Ok({
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
    });
  }

  /**
   * POST /projects/:slug/vcs/sync
   * Trigger full sync run
   */
  @Post('/sync')
  @Requires('vcs.sync.all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger a full sync of all issues from the VCS provider' })
  @ApiResponse({ status: 200, description: 'Full sync completed', type: SyncResultDto })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.sync.all required' })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async syncAll(
    @Param('slug') slug: string,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.vcsConfig.encryptionKey;
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Run full sync
    const result = await this.syncService.fullSync(project, connection, encryptionKey);

    return JsonResponse.Ok({
      syncType: 'manual',
      issuesSynced: result.issuesSynced,
      issuesSkipped: result.issuesSkipped,
      tickets: result.createdTickets.map((ticket) => ({
        ref: `${project.key}-${ticket.number}`,
        title: ticket.title,
      })),
    });
  }

  /**
   * POST /projects/:slug/vcs/sync-pr
   * Trigger manual PR status sync for all active PRs
   */
  @Post('/sync-pr')
  @Requires('vcs.sync.pr')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually sync PR status for all active pull requests' })
  @ApiResponse({ status: 200, description: 'PR sync completed', type: Object })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden - project access and vcs.sync.pr required' })
  @ApiResponse({ status: 404, description: 'Project or VCS connection not found' })
  async syncPr(
    @Param('slug') slug: string,
  ) {
    // Get project by slug
    const project = await this.projectsService.findBySlug(slug);

    // Get encryption key from config
    const encryptionKey = this.vcsConfig.encryptionKey;
    if (!encryptionKey) {
      this.throwEncryptionKeyNotConfigured();
    }

    // Get the full connection with all fields
    const connection = await this.vcsService.getFullByProject(project.id);

    // Run PR sync
    const result = await this.prSyncService.syncPrStatus(project, connection, encryptionKey, 'vcs.sync.pr');

    return JsonResponse.Ok({ updated: result.updated });
  }
}
