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

export const FLEET_REPO_ROUTE_VARIANTS = {
  create: 'rest:fleet-repos.create',
  delete: 'rest:fleet-repos.delete',
  check: 'rest:fleet-repos.check',
} as const;

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
      run: (_principal, input) => this.repos.check(input.id),
      toResult: (result) => result,
    }, this.loader));
  }
}
