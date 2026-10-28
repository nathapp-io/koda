import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';
import { ConfigJobsService } from './config-jobs.service';

export const REPO_CONFIG_ROUTE_VARIANTS = {
  driftCheck: 'rest:project-repo-config.drift-check',
} as const;

@Injectable()
export class RepoConfigRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly configJobs: ConfigJobsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string; repoId: string }, DispatchResultDto>({
      key: 'fleet.repo.drift.check', variant: REPO_CONFIG_ROUTE_VARIANTS.driftCheck,
      parse: (input) => parseRouteInput(input, ['projectId', 'repoId']),
      prepare: (principal, input) => this.configJobs.prepareDrift(principal.id, input.projectId, input.repoId),
      run: (principal, input) => this.configJobs.submitDrift(principal.id, input.projectId, input.repoId),
      toResult: (result) => result,
    }, this.loader));
  }
}
