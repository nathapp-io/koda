import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { PermissionService } from '../../permissions/permission.service';
import { SchedulesService } from './schedules.service';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';

export const SCHEDULE_ROUTE_VARIANTS = {
  create: 'rest:project-fleet-schedules.create',
  update: 'rest:project-fleet-schedules.update',
  enable: 'rest:project-fleet-schedules.enable',
  disable: 'rest:project-fleet-schedules.disable',
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
    this.commands.register(routeCommand<{ slug: string; projectId: string; schedule: CreateScheduleDto }, Awaited<ReturnType<SchedulesService['create']>>>({
      key: 'fleet.schedule.create', variant: SCHEDULE_ROUTE_VARIANTS.create,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, schedule: parseBody(CreateScheduleDto, value.schedule ?? {}) };
      },
      run: (principal, input) => this.schedules.create(principal.id, input.projectId, input.schedule),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; patch: UpdateScheduleDto }, Awaited<ReturnType<SchedulesService['update']>>>({
      key: 'fleet.schedule.update', variant: SCHEDULE_ROUTE_VARIANTS.update,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, patch: parseBody(UpdateScheduleDto, value.patch ?? {}) };
      },
      run: async (principal, input) => {
        const canAdminister = (await this.permissions.can(principal, 'fleet.schedule.update', { projectId: input.projectId })).allowed;
        return this.schedules.update(principal.id, input.projectId, input.id, input.patch, canAdminister);
      },
      toResult: (result) => result,
    }, this.loader));

    for (const action of ['enable', 'disable'] as const) {
      this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Awaited<ReturnType<SchedulesService[typeof action]>>>({
        key: 'fleet.schedule.update', variant: SCHEDULE_ROUTE_VARIANTS[action],
        parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
        run: async (principal, input) => {
          const canAdminister = (await this.permissions.can(principal, 'fleet.schedule.update', { projectId: input.projectId })).allowed;
          return this.schedules[action](principal.id, input.projectId, input.id, canAdminister);
        },
        toResult: (result) => result,
      }, this.loader));
    }

    this.commands.register(routeCommand<{ projectId: string; id: string }, null>({
      key: 'fleet.schedule.delete', variant: SCHEDULE_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['projectId', 'id']),
      run: async (principal, input) => {
        const canAdminister = (await this.permissions.can(principal, 'fleet.schedule.delete', { projectId: input.projectId })).allowed;
        await this.schedules.remove(principal.id, input.projectId, input.id, canAdminister);
        return null;
      },
    }, this.loader));
  }
}
