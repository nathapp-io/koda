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

export const FLEET_REPO_ROUTE_VARIANTS = {
  create: 'rest:fleet-repos.create',
  delete: 'rest:fleet-repos.delete',
  check: 'rest:fleet-repos.check',
  autoReview: 'rest:fleet-repos.auto-review',
} as const;

/** The `{ id, patch }` input the auto-review route freezes: an id-addressed write with a body. */
interface AutoReviewInput {
  id: string;
  patch: UpdateAutoReviewDto;
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
  }
}
