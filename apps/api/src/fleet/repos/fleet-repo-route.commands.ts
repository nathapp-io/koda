import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { redactSecret } from '../../approvals/route/redact-secret';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';
import { UpdateFixChecksDto } from './dto/update-fix-checks.dto';
import { UpdateFixUnprotectedDto } from './dto/update-fix-unprotected.dto';
import { UpdateGitlabCredentialsDto } from './dto/update-gitlab-credentials.dto';
import { validateRuleOverride } from './rule-override';

export const FLEET_REPO_ROUTE_VARIANTS = {
  create: 'rest:fleet-repos.create',
  delete: 'rest:fleet-repos.delete',
  check: 'rest:fleet-repos.check',
  autoReview: 'rest:fleet-repos.auto-review',
  fixChecks: 'rest:fleet-repos.fix-checks',
  fixUnprotected: 'rest:fleet-repos.fix-unprotected',
  gitlabCredentials: 'rest:fleet-repos.gitlab-credentials',
  ruleOverrideSet: 'rest:fleet-repos.rule-override.set',
  ruleOverrideClear: 'rest:fleet-repos.rule-override.clear',
} as const;

/** The `{ id, patch }` input the auto-review route freezes: an id-addressed write with a body. */
interface AutoReviewInput {
  id: string;
  patch: UpdateAutoReviewDto;
}

/** The same `{ id, patch }` shape for the fix-checks route (fleet FIX US-001). */
interface FixChecksInput {
  id: string;
  patch: UpdateFixChecksDto;
}

/** The same `{ id, patch }` shape for the fix-unprotected override route. */
interface FixUnprotectedInput {
  id: string;
  patch: UpdateFixUnprotectedDto;
}

/** The same `{ id, patch }` shape for the GitLab credential rotation (US-005). */
interface GitlabCredentialsInput {
  id: string;
  patch: UpdateGitlabCredentialsDto;
}

/**
 * The rule-override set route's frozen input (#370): the repo id and the raw body. The body is
 * validated by the pure validator, both here (so a frozen input that cannot run is refused
 * before it does) and again in the service when the approved request runs.
 */
interface RuleOverrideSetInput {
  id: string;
  body: unknown;
}

@Injectable()
export class FleetRepoRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly repos: FleetReposService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    // US-004: the create body carries the two tokens when it names a GitLab repo, so `redeem.redact`
    // replaces them with the marker: neither the approval request row nor the hash a redemption
    // compares against ever holds a token. The request redeems only when the redaction removed
    // something, so a GitHub body — which carries no token at all — keeps the ordinary flow: an
    // approved request registers the repo, as it always did.
    this.commands.register(routeCommand<CreateFleetRepoDto, FleetRepoDto>({
      key: 'fleet.repo.create', variant: FLEET_REPO_ROUTE_VARIANTS.create,
      parse: (input) => parseBody(CreateFleetRepoDto, input),
      redeem: { redact: (input) => redactGitLabTokens(input), onlyWhenRedacted: true },
      prepare: (principal, input) => this.repos.prepareCreate(principal.id, input),
      run: (principal, input) => this.repos.create(principal.id, input),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'fleet.repo.delete', variant: FLEET_REPO_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => {
        await this.repos.remove(principal.id, input.id);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, RepoCheckResultDto>({
      key: 'fleet.repo.check', variant: FLEET_REPO_ROUTE_VARIANTS.check,
      parse: (input) => parseRouteInput(input, ['id']),
      prepare: (_principal, input) => this.repos.prepareCheck(input.id),
      run: (_principal, input) => this.repos.check(input.id),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<AutoReviewInput, FleetRepoDto>({
      key: 'fleet.repo.review.configure', variant: FLEET_REPO_ROUTE_VARIANTS.autoReview,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateAutoReviewDto, (input as { patch?: unknown }).patch) };
      },
      run: (principal, input) => this.repos.configureAutoReview(principal, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<FixChecksInput, FleetRepoDto>({
      key: 'fleet.repo.review.configure', variant: FLEET_REPO_ROUTE_VARIANTS.fixChecks,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateFixChecksDto, (input as { patch?: unknown }).patch) };
      },
      run: (principal, input) => this.repos.configureFixChecks(principal, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<FixUnprotectedInput, FleetRepoDto>({
      key: 'fleet.repo.fix.unprotected', variant: FLEET_REPO_ROUTE_VARIANTS.fixUnprotected,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateFixUnprotectedDto, (input as { patch?: unknown }).patch) };
      },
      run: (principal, input) => this.repos.configureFixUnprotected(principal, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<RuleOverrideSetInput, FleetRepoDto>({
      key: 'fleet.repo.rules.configure', variant: FLEET_REPO_ROUTE_VARIANTS.ruleOverrideSet,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        const body = (input as { body?: unknown }).body;
        // The frozen body must be one the validator accepts, so a request that cannot run is
        // refused here rather than at execution.
        validateRuleOverride(body);
        return { id, body };
      },
      run: (principal, input) => this.repos.setRuleOverride(principal, input.id, input.body),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<GitlabCredentialsInput, FleetRepoDto>({
      key: 'fleet.repo.credentials.update', variant: FLEET_REPO_ROUTE_VARIANTS.gitlabCredentials,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateGitlabCredentialsDto, (input as { patch?: unknown }).patch) };
      },
      // US-005: the body carries tokens, so `redeem.redact` replaces them with the marker: neither the
      // approval request row nor the hash a redemption compares against ever holds a token. Approving
      // such a request runs nothing; the requester redeems it by repeating the call with the token it
      // actually wants stored, and that body is what lands.
      redeem: { redact: ({ id, patch }) => ({ id, patch: redactGitlabCredentialTokens(patch) }) },
      // The forge verification runs in `prepare`, outside the approval execution's transaction; the write
      // and the deferred cache eviction run in the transaction the engine owns.
      prepare: (_principal, input) => this.repos.prepareRotateGitlabCredentials(input.id, input.patch),
      run: (_principal, input) => this.repos.rotateGitlabCredentials(input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, FleetRepoDto>({
      key: 'fleet.repo.rules.configure', variant: FLEET_REPO_ROUTE_VARIANTS.ruleOverrideClear,
      parse: (input) => parseRouteInput(input, ['id']),
      run: (principal, input) => this.repos.clearRuleOverride(principal, input.id),
      toResult: (result) => result,
    }, this.loader));
  }
}

/**
 * US-004: the stored form of a create body. The two tokens become the redaction marker and every
 * other field is unchanged; an absent token stays absent, because a body without a token has
 * nothing to redact.
 */
function redactGitLabTokens(input: CreateFleetRepoDto): Record<string, unknown> {
  const { readToken, writeToken, ...rest } = input;
  return {
    ...rest,
    ...(readToken === undefined ? {} : { readToken: redactSecret(readToken) }),
    ...(writeToken === undefined ? {} : { writeToken: redactSecret(writeToken) }),
  };
}

/**
 * US-005: the stored form of a rotation body. Each token the body carries becomes the redaction
 * marker and every other field is unchanged; a token the body does not carry stays absent, because a
 * partial rotation has nothing to redact for the token it keeps.
 */
function redactGitlabCredentialTokens(patch: UpdateGitlabCredentialsDto): Record<string, unknown> {
  const { readToken, writeToken, ...rest } = patch;
  return {
    ...rest,
    ...(readToken === undefined ? {} : { readToken: redactSecret(readToken) }),
    ...(writeToken === undefined ? {} : { writeToken: redactSecret(writeToken) }),
  };
}
