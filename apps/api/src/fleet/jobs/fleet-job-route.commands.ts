import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { DispatchFleetJobDto } from './dto/dispatch-fleet-job.dto';
import { DispatchResultDto, FleetJobDto } from './dto/fleet-job.dto';
import { PermissionService } from '../../permissions/permission.service';
import { FleetJobsService } from './fleet-jobs.service';

export const FLEET_JOB_ROUTE_VARIANTS = {
  dispatch: 'rest:fleet-jobs.dispatch',
  requeue: 'rest:fleet-jobs.requeue',
  cancel: 'rest:fleet-jobs.cancel',
} as const;

@Injectable()
export class FleetJobRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly jobs: FleetJobsService,
    private readonly loader: ActorPrincipalLoader,
    private readonly permissions: PermissionService,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, FleetJobDto>({
      key: 'fleet.job.cancel', variant: FLEET_JOB_ROUTE_VARIANTS.cancel,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      skipKeyRecheck: true, // The service rechecks requester-or-key, not key alone.
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'fleet.job.cancel', { projectId: input.projectId })).allowed;
        return this.jobs.cancel(principal.id, input.projectId, input.id, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string; dispatch: DispatchFleetJobDto }, DispatchResultDto>({
      key: 'fleet.job.dispatch', variant: FLEET_JOB_ROUTE_VARIANTS.dispatch,
      parse: (input) => ({
        ...parseRouteInput(input, ['slug', 'projectId']),
        dispatch: parseBody(DispatchFleetJobDto, (input as Record<string, unknown>).dispatch ?? {}),
      }),
      run: (principal, input) => this.jobs.dispatch(principal.id, input.projectId, input.dispatch, {
        ticketActor: { principal, projectSlug: input.slug },
      }),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, DispatchResultDto>({
      key: 'fleet.job.requeue', variant: FLEET_JOB_ROUTE_VARIANTS.requeue,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: (principal, input) => this.jobs.requeue(principal.id, input.projectId, input.id),
      toResult: (result) => result,
    }, this.loader));
  }
}
