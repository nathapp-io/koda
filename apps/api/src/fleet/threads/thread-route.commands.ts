import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { PermissionService } from '../../permissions/permission.service';
import { ThreadsService } from './threads.service';
import { CreateThreadDto, UpdateThreadDto } from './dto/thread.dto';

export const THREAD_ROUTE_VARIANTS = {
  create: 'rest:threads.create',
  update: 'rest:threads.update',
  archive: 'rest:threads.archive',
} as const;

@Injectable()
export class ThreadRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly threads: ThreadsService,
    private readonly permissions: PermissionService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ slug: string; projectId: string; thread: CreateThreadDto }, Awaited<ReturnType<ThreadsService['create']>>>({
      key: 'thread.create', variant: THREAD_ROUTE_VARIANTS.create,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, thread: parseBody(CreateThreadDto, value.thread ?? {}) };
      },
      run: (principal, input) => this.threads.create(input.projectId, principal.id, input.thread),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; patch: UpdateThreadDto }, Awaited<ReturnType<ThreadsService['updateCap']>>>({
      key: 'thread.cap.update', variant: THREAD_ROUTE_VARIANTS.update,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, patch: parseBody(UpdateThreadDto, value.patch ?? {}) };
      },
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.cap.update', { projectId: input.projectId })).allowed;
        return this.threads.updateCap(input.projectId, input.id, principal.id, input.patch.maxCostUsd, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Awaited<ReturnType<ThreadsService['get']>>>({
      key: 'thread.archive', variant: THREAD_ROUTE_VARIANTS.archive,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.archive', { projectId: input.projectId })).allowed;
        await this.threads.archive(input.projectId, input.id, principal.id, canOperate);
        return this.threads.get(input.projectId, input.id);
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
