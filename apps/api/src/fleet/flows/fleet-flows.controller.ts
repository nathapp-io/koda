import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { AppException, ForbiddenAppException, JsonResponse, NotFoundAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectsService } from '../../projects/projects.service';
import { parseGitHubUrl } from '../../skills/github-url';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from '../repos/fleet-repos.service';
import { FleetFlowDto } from './dto/fleet-flow.dto';
import { FleetFlowsService, type CreatedFlow } from './fleet-flows.service';
import { parseFlowInput } from './flow-input';
import { NAX_FLOW_CREATE_VARIANT } from './flow-route.commands';

@ApiTags('fleet')
@ApiBearerAuth()
@Controller('fleet/flows')
@UseGuards(RequiresGuard)
export class FleetFlowsController {
  constructor(
    private readonly repos: FleetReposService,
    private readonly projects: ProjectsService,
    private readonly permissions: PermissionService,
    private readonly github: GitHubAppClient,
    private readonly routeGate: ApprovalRouteGate,
    private readonly flows: FleetFlowsService,
  ) {}

  @Get(':flowId')
  @Requires('fleet.flow.read', { enforcedBy: 'service' })
  @ApiOperation({ summary: 'Read a fleet flow in its reachable project (fleet.flow.read)' })
  @ApiResponse({ status: 200, type: FleetFlowDto })
  @ApiResponse({ status: 403, description: 'fleet.flow.read is missing in the flow project' })
  @ApiResponse({ status: 404, description: 'fleet.flows.notFound' })
  async get(@Param('flowId') flowId: string, @Principal() principal: KodaPrincipal) {
    const flow = await this.flows.findById(flowId);
    const project = await this.projects.findReachableById(principal, flow.projectId);
    if (!project) throw new NotFoundAppException({}, 'fleet.flows.notFound');
    if (!(await this.permissions.can(principal, 'fleet.flow.read', { projectId: project.id })).allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }
    return JsonResponse.Ok(FleetFlowDto.from(flow, project.slug));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  // This global URL resolves its project from a reachable repo before checking the project key.
  @Requires('fleet.flow.create', { enforcedBy: 'service' })
  @ApprovalGated()
  @ApiOperation({ summary: 'Create a nax fleet flow from verified branch-head specs (fleet.flow.create)' })
  @ApiBody({ schema: { type: 'object', required: ['features', 'roles', 'costCapUsd', 'remoteUrl', 'branch', 'specSha'], properties: {
    features: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', required: ['feature', 'specPath'], properties: { feature: { type: 'string' }, specPath: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } } } } },
    roles: { type: 'object', required: ['reviewer', 'supervisor'], properties: { reviewer: { type: 'string' }, supervisor: { type: 'string' } } },
    costCapUsd: { oneOf: [{ type: 'number' }, { type: 'string' }] }, remoteUrl: { type: 'string', description: 'HTTPS github.com repository URL' },
    branch: { type: 'string' }, specSha: { type: 'string', pattern: '^[a-f0-9]{40}$' },
  } } })
  @ApiResponse({ status: 201, type: FleetFlowDto })
  @ApiResponse({ status: 202, description: 'Approval request for fleet.flow.create' })
  @ApiResponse({ status: 400, description: 'Invalid flow input, naming the property' })
  @ApiResponse({ status: 403, description: 'fleet.flow.create is missing in the repository project' })
  @ApiResponse({ status: 404, description: 'fleet.flows.repoNotFound' })
  @ApiResponse({ status: 409, description: 'Repository not connected, branch missing, SHA not head, or duplicate live flow' })
  @ApiResponse({ status: 422, description: 'fleet.flows.specMissing, naming the path' })
  @ApiResponse({ status: 503, description: 'fleet.flows.forgeUnavailable' })
  async create(@Body() body: unknown, @Principal() principal: KodaPrincipal) {
    const parsed = parseFlowInput(body, 'NAX');
    // NAX parsing validates these three required fields, including the supported remote URL shape.
    const { owner, repo: name } = parseGitHubUrl(parsed.remoteUrl);
    const { branch, specSha } = parsed;
    const repo = await this.repos.findByIdentity('github', owner, name);
    if (!repo) throw new NotFoundAppException({}, 'fleet.flows.repoNotFound');
    const project = (await this.projects.findAllForPrincipal(principal)).find((candidate) => candidate.id === repo.projectId);
    if (!project) throw new NotFoundAppException({}, 'fleet.flows.repoNotFound');
    if (!(await this.permissions.can(principal, 'fleet.flow.create', { projectId: project.id })).allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }
    if (repo.githubInstallationId === null) throw new ConflictAppException({}, 'fleet.flows.repoNotConnected');

    // All external reads finish before the gate can open a transaction or persist approval input.
    // Only the immutable snapshot and resolved identities cross that boundary, never the token.
    try {
      const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId, repo.name);
      const head = await this.github.getBranchHead(token, repo.owner, repo.name, branch);
      if (head !== specSha) throw new ConflictAppException({}, 'fleet.flows.specShaNotHead');
      const files = await Promise.all(parsed.features.map(({ specPath }) => this.github.getFile(token, repo.owner, repo.name, specPath, specSha)));
      const missing = parsed.features.find((_, index) => files[index] === null);
      // No specific Nathapp App exception exists for 422/503; keep their i18n code and HTTP status.
      if (missing) throw new AppException(422, { path: missing.specPath }, 'fleet.flows.specMissing', 422);
    } catch (error) {
      if (!(error instanceof RepoCheckException)) throw error;
      switch (error.reason) {
        case 'app_not_installed':
        case 'app_permissions_insufficient':
          throw new ConflictAppException({}, 'fleet.flows.repoNotConnected');
        case 'repo_not_found':
          throw new ConflictAppException({}, 'fleet.flows.branchNotFound');
        case 'github_app_not_configured':
        case 'github_app_key_unreadable':
        case 'provider_unreachable':
        case 'provider_error':
          throw new AppException(503, {}, 'fleet.flows.forgeUnavailable', 503);
        default:
          throw error;
      }
    }

    const outcome = await this.routeGate.run<CreatedFlow>({
      key: 'fleet.flow.create', variant: NAX_FLOW_CREATE_VARIANT, projectId: project.id, keyCheck: false,
      input: { projectId: project.id, repoId: repo.id, body: parsed },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(FleetFlowDto.from(outcome.result.flow, project.slug));
  }
}
