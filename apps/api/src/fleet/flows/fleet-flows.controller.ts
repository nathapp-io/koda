import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '@nathapp/nestjs-auth';
import { AppException, ForbiddenAppException, JsonResponse, NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ApprovalGated } from '../../approvals/route/approval-gated.decorator';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { PermissionService } from '../../permissions/permission.service';
import { Requires } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectsService } from '../../projects/projects.service';
import type { ProjectDomain } from '../../projects/domain/project.domain';
import { parseFlowRemoteUrl } from './flow-remote-url';
import { GitHubAppClient } from '../git-broker/github-app-client';
import { GitLabAccessChecker } from '../git-broker/gitlab-access-checker';
import { GitLabRepoCredentials } from '../git-broker/gitlab-repo-credentials';
import { RepoCheckException } from '../git-broker/repo-check.exception';
import { FleetReposService } from '../repos/fleet-repos.service';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import { FleetFlowDto } from './dto/fleet-flow.dto';
import { FleetFlowsService, type CreatedFlow } from './fleet-flows.service';
import { parseFlowInput, type NormalizedNaxFlowInput } from './flow-input';
import { parseFlowHandoffInput, readHandoffPrd, type NormalizedHandoffFlowInput } from './flow-handoff-input';
import { NAX_FLOW_CREATE_VARIANT, NAX_HANDOFF_FLOW_CREATE_VARIANT } from './flow-route.commands';

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
    private readonly gitlabCredentials: GitLabRepoCredentials,
    private readonly gitlab: GitLabAccessChecker,
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
    costCapUsd: { oneOf: [{ type: 'number' }, { type: 'string' }] }, remoteUrl: { type: 'string', description: 'HTTPS github.com or GitLab repository URL' },
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
    // A body carries either `features` (the spec form) or `handoff` (the handoff form), never both.
    if (isHandoffBody(body)) {
      const handoff = parseFlowHandoffInput(body);
      const { repo, project } = await this.resolveRepo(handoff.remoteUrl, principal);
      await this.checkHandoff(handoff, repo);
      const outcome = await this.routeGate.run<CreatedFlow>({
        key: 'fleet.flow.create', variant: NAX_HANDOFF_FLOW_CREATE_VARIANT, projectId: project.id, keyCheck: false,
        input: { projectId: project.id, repoId: repo.id, body: handoff },
      });
      if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
      return JsonResponse.Ok(FleetFlowDto.from(outcome.result.flow, project.slug));
    }

    const parsed = parseFlowInput(body, 'NAX');
    const { repo, project } = await this.resolveRepo(parsed.remoteUrl, principal);
    await this.checkSpecFiles(parsed, repo);
    const outcome = await this.routeGate.run<CreatedFlow>({
      key: 'fleet.flow.create', variant: NAX_FLOW_CREATE_VARIANT, projectId: project.id, keyCheck: false,
      input: { projectId: project.id, repoId: repo.id, body: parsed },
    });
    if (outcome.status === 'pending') throw new ApprovalPending(outcome.request);
    return JsonResponse.Ok(FleetFlowDto.from(outcome.result.flow, project.slug));
  }

  /**
   * The repository the body names, the project it lives in and the caller's right to create a flow
   * there. Both forms resolve the repo the same way; a repo the caller cannot reach is hidden.
   */
  private async resolveRepo(remoteUrl: string, principal: KodaPrincipal): Promise<{ repo: FleetRepoRecord; project: ProjectDomain }> {
    // NAX parsing validates the supported remote URL shape, so this parse only canonicalises it.
    const remote = parseFlowRemoteUrl(remoteUrl);
    // The lookup key is the canonical URL the parser produced, not the submitted string: a registered
    // GitLab repo is stored under its canonical host, namespace and name, so a clone URL that still
    // carries a `.git` suffix or a trailing slash has to be canonicalised before it is matched.
    const repo = remote.provider === 'gitlab'
      ? await this.repos.findGitLabByRemoteUrl(remote.url)
      : await this.repos.findByIdentity('github', remote.owner, remote.name);
    if (!repo) throw new NotFoundAppException({}, 'fleet.flows.repoNotFound');
    const project = (await this.projects.findAllForPrincipal(principal)).find((candidate) => candidate.id === repo.projectId);
    if (!project) throw new NotFoundAppException({}, 'fleet.flows.repoNotFound');
    if (!(await this.permissions.can(principal, 'fleet.flow.create', { projectId: project.id })).allowed) {
      throw new ForbiddenAppException({}, 'permissions');
    }
    // GitLab provider identity takes precedence over the GitHub installation field: that field is
    // null on ordinary GitLab rows, but its value must never route a GitLab row through GitHub.
    if (repo.provider !== 'gitlab' && repo.githubInstallationId === null) {
      throw new ConflictAppException({}, 'fleet.flows.repoNotConnected');
    }
    return { repo, project };
  }

  /**
   * The spec form's own read: the branch head is the spec sha and every spec file is there at it.
   * All external reads finish before the gate can open a transaction or persist approval input.
   * Only the immutable snapshot and resolved identities cross that boundary, never the token.
   */
  private async checkSpecFiles(parsed: NormalizedNaxFlowInput, repo: FleetRepoRecord): Promise<void> {
    const { branch, specSha } = parsed;
    try {
      if (repo.provider === 'gitlab') {
        const head = await this.gitlabCredentials.call(repo, 'read', (access) => this.gitlab.getBranchHead(access, branch));
        if (head !== specSha) throw new ConflictAppException({}, 'fleet.flows.specShaNotHead');
        const files = await Promise.all(parsed.features.map(({ specPath }) =>
          this.gitlabCredentials.call(repo, 'read', (access) => this.gitlab.getFile(access, specPath, specSha))));
        const missing = parsed.features.find((_, index) => files[index] === null);
        if (missing) throw new AppException(422, { path: missing.specPath }, 'fleet.flows.specMissing', 422);
      } else {
        const { token } = await this.github.mintReadOnlyToken(repo.githubInstallationId as bigint, repo.name);
        const head = await this.github.getBranchHead(token, repo.owner, repo.name, branch);
        if (head !== specSha) throw new ConflictAppException({}, 'fleet.flows.specShaNotHead');
        const files = await Promise.all(parsed.features.map(({ specPath }) => this.github.getFile(token, repo.owner, repo.name, specPath, specSha)));
        const missing = parsed.features.find((_, index) => files[index] === null);
        if (missing) throw new AppException(422, { path: missing.specPath }, 'fleet.flows.specMissing', 422);
      }
    } catch (error) {
      this.mapForgeError(error, repo.provider);
    }
  }

  /**
   * The handoff checks: the forge must still hold what the chat run claimed, so the flow that takes
   * the feature over publishes the very branch the chain prepared. Every read fails closed — a
   * refusal never creates a flow.
   */
  private async checkHandoff(handoff: NormalizedHandoffFlowInput, repo: FleetRepoRecord): Promise<void> {
    // A handoff never runs on the default branch: the chain pushed its own branch.
    if (handoff.branch === repo.defaultBranch) {
      throw new ValidationAppException({ reason: 'branch' }, 'fleet.flowInput');
    }
    if (repo.provider === 'gitlab') {
      // US-005 adds the GitLab handoff reads (the read credential and the merge-request listing).
      // Until then the form fails closed: a GitLab handoff never creates a flow.
      throw new ConflictAppException({}, 'fleet.flows.gitlabNotConnected');
    }
    const { feature, headSha } = handoff.handoff;
    const prdPath = `.nax/features/${feature}/prd.json`;
    try {
      // The thread read token can list pull requests; the read-only one cannot, so the handoff form
      // never mints it.
      const { token } = await this.github.mintThreadReadToken(repo.githubInstallationId as bigint, repo.name);
      const head = await this.github.getBranchHead(token, repo.owner, repo.name, handoff.branch);
      if (head !== headSha) throw new ConflictAppException({}, 'fleet.flows.handoffHeadMoved');
      const prd = await this.github.getFile(token, repo.owner, repo.name, prdPath, headSha);
      if (prd === null) throw new AppException(422, { path: prdPath }, 'fleet.flows.prdMissing', 422);
      const read = readHandoffPrd(prd.content.toString('utf8'));
      if (read === null) throw new AppException(422, { path: prdPath }, 'fleet.flows.prdMissing', 422);
      // The runner checks out `prd.branchName`, so a mismatch would publish another branch than the
      // one this flow guards.
      if (read.branchName === null || read.branchName !== handoff.branch) {
        throw new AppException(422, {}, 'fleet.flows.handoffBranchMismatch', 422);
      }
      if (read.pendingStoryIds.length > 0) {
        throw new AppException(422, { storyIds: read.pendingStoryIds }, 'fleet.flows.handoffStoriesPending', 422);
      }
      const pullRequests = await this.github.listOpenPullRequests(token, repo.owner, repo.name);
      // A pull request from another repository (a fork) is not this feature's: the handoff only
      // refuses a pull request the same repository already opened at this head.
      const open = pullRequests.find((pullRequest) =>
        pullRequest.headRepoFullName === `${repo.owner}/${repo.name}` && pullRequest.headSha === headSha);
      if (open) throw new ConflictAppException({ prNumber: open.number }, 'fleet.flows.handoffPrOpen');
    } catch (error) {
      this.mapForgeError(error, repo.provider);
    }
  }

  /**
   * The forge failure mapping both forms share: a `RepoCheckException` becomes the API's own
   * refusal, exactly as the spec form maps it.
   */
  private mapForgeError(error: unknown, provider: string): never {
    if (!(error instanceof RepoCheckException)) throw error;
    if (provider === 'gitlab') {
      switch (error.reason) {
        case 'gitlab_credentials_missing':
        case 'gitlab_token_invalid':
        case 'app_permissions_insufficient':
          throw new ConflictAppException({}, 'fleet.flows.gitlabNotConnected');
        case 'repo_not_found':
          throw new ConflictAppException({}, 'fleet.flows.branchNotFound');
        case 'provider_unreachable':
        case 'provider_error':
        case 'vcs_encryption_key_missing':
          throw new AppException(503, {}, 'fleet.flows.forgeUnavailable', 503);
        default:
          throw error;
      }
    }
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
}

/** Whether the body carries the handoff form. A body with both forms is refused by the parser. */
function isHandoffBody(body: unknown): boolean {
  return typeof body === 'object' && body !== null && !Array.isArray(body) && Object.hasOwn(body, 'handoff');
}
