import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { PermissionService } from '../../permissions/permission.service';
import { SchedulesService } from './schedules.service';

export const SCHEDULE_ROUTE_VARIANTS = {
  delete: 'rest:project-fleet-schedules.delete',
} as const;

@Injectable()
export class ScheduleRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly schedules: SchedulesService,
    private readonly permissions: PermissionService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ projectId: string; id: string }, null>({
      key: 'fleet.schedule.delete', variant: SCHEDULE_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['projectId', 'id']),
      run: async (principal, input) => {
        // Any-row authority belongs to the requester at execution, never to the approver or frozen input.
        const canAdminister = (await this.permissions.can(principal, 'fleet.schedule.delete', { projectId: input.projectId })).allowed;
        await this.schedules.remove(principal.id, input.projectId, input.id, canAdminister);
        return null;
      },
    }, this.loader));
  }
}
