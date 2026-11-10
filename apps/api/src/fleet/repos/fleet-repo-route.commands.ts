import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { FleetReposService } from './fleet-repos.service';
import { CreateFleetRepoDto } from './dto/create-fleet-repo.dto';
import { FleetRepoDto } from './dto/fleet-repo.dto';
import { RepoCheckResultDto } from './dto/repo-check-result.dto';
import { UpdateAutoReviewDto } from './dto/update-auto-review.dto';
import { UpdateFixChecksDto } from './dto/update-fix-checks.dto';
import { UpdateFixUnprotectedDto } from './dto/update-fix-unprotected.dto';
import { validateRuleOverride } from './rule-override';

export const FLEET_REPO_ROUTE_VARIANTS = {
  create: 'rest:fleet-repos.create',
  delete: 'rest:fleet-repos.delete',
  check: 'rest:fleet-repos.check',
  autoReview: 'rest:fleet-repos.auto-review',
  fixChecks: 'rest:fleet-repos.fix-checks',
  fixUnprotected: 'rest:fleet-repos.fix-unprotected',
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
    this.commands.register(routeCommand<CreateFleetRepoDto, FleetRepoDto>({
      key: 'fleet.repo.create', variant: FLEET_REPO_ROUTE_VARIANTS.create,
      parse: (input) => parseBody(CreateFleetRepoDto, input),
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
    this.commands.register(routeCommand<{ id: string }, FleetRepoDto>({
      key: 'fleet.repo.rules.configure', variant: FLEET_REPO_ROUTE_VARIANTS.ruleOverrideClear,
      parse: (input) => parseRouteInput(input, ['id']),
      run: (principal, input) => this.repos.clearRuleOverride(principal, input.id),
      toResult: (result) => result,
    }, this.loader));
  }
}
