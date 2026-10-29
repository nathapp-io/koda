import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { parseBody } from '../../approvals/route/parse-body';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { DispatchResultDto } from '../jobs/dto/fleet-job.dto';
import { ConfigJobsService } from './config-jobs.service';
import { RegenerateConfigDto, SubmitConfigEditDto } from './dto/config-edit.dto';

export const REPO_CONFIG_ROUTE_VARIANTS = {
  driftCheck: 'rest:project-repo-config.drift-check',
  configEdit: 'rest:project-repo-config.config-edit',
  regenerate: 'rest:project-repo-config.regenerate',
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

    this.commands.register(routeCommand<{ slug: string; projectId: string; repoId: string; edit: SubmitConfigEditDto }, DispatchResultDto>({
      key: 'fleet.job.config.edit', variant: REPO_CONFIG_ROUTE_VARIANTS.configEdit,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'repoId']);
        const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).edit : undefined;
        return { ...route, edit: parseBody(SubmitConfigEditDto, raw ?? {}) };
      },
      run: (principal, input) => this.configJobs.submitEdit(principal.id, input.projectId, input.repoId, input.edit),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; repoId: string; regenerate: RegenerateConfigDto }, DispatchResultDto>({
      key: 'fleet.job.config.edit', variant: REPO_CONFIG_ROUTE_VARIANTS.regenerate,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'repoId']);
        const raw = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).regenerate : undefined;
        return { ...route, regenerate: parseBody(RegenerateConfigDto, raw ?? {}) };
      },
      prepare: (principal, input) => this.configJobs.prepareRegenerate(principal.id, input.projectId, input.repoId, input.regenerate),
      run: (principal, input) => this.configJobs.submitRegenerate(principal.id, input.projectId, input.repoId, input.regenerate),
      toResult: (result) => result,
    }, this.loader));
  }
}
