import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { WorkspaceThreadsService } from './workspace-threads.service';
import { CreateWorkspaceThreadDto } from './dto/workspace-thread.dto';
import { AnswerQuestionDto, UpdateThreadDto } from './dto/thread.dto';

export const WORKSPACE_THREAD_ROUTE_VARIANTS = {
  create: 'rest:workspace-threads.create',
  archive: 'rest:workspace-threads.archive',
  update: 'rest:workspace-threads.update',
  stop: 'rest:workspace-threads.stop',
  endSession: 'rest:workspace-threads.end-session',
  answer: 'rest:workspace-threads.answer',
} as const;

@Injectable()
export class WorkspaceThreadRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly workspace: WorkspaceThreadsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ thread: CreateWorkspaceThreadDto }, Awaited<ReturnType<WorkspaceThreadsService['create']>>>({
      key: 'thread.workspace.create', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.create,
      parse: (input) => {
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { thread: parseBody(CreateWorkspaceThreadDto, value.thread ?? {}) };
      },
      run: (principal, input) => this.workspace.create(principal, input.thread),
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ id: string; patch: UpdateThreadDto }, Awaited<ReturnType<WorkspaceThreadsService['updateCap']>>>({
      key: 'thread.cap.update', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.update,
      parse: (input) => {
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { id: parseRouteInput(value, ['id']).id, patch: parseBody(UpdateThreadDto, value.patch ?? {}) };
      },
      run: (principal, input) => this.workspace.updateCap(principal, input.id, input.patch.maxCostUsd),
      toResult: (result) => result,
      skipKeyRecheck: true,
    }, this.loader));

    this.commands.register(routeCommand<{ id: string }, Record<string, never>>({
      key: 'thread.stop', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.stop,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => { await this.workspace.stop(principal, input.id); return {}; },
      toResult: (result) => result,
      skipKeyRecheck: true,
    }, this.loader));

    this.commands.register(routeCommand<{ id: string }, Record<string, never>>({
      key: 'thread.end-session', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.endSession,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => { await this.workspace.endSession(principal, input.id); return {}; },
      toResult: (result) => result,
      skipKeyRecheck: true,
    }, this.loader));

    this.commands.register(routeCommand<{ id: string; answer: AnswerQuestionDto }, Record<string, never>>({
      key: 'thread.answer', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.answer,
      parse: (input) => {
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { id: parseRouteInput(value, ['id']).id, answer: parseBody(AnswerQuestionDto, value.answer ?? {}) };
      },
      run: async (principal, input) => { await this.workspace.answer(principal, input.id, input.answer); return {}; },
      toResult: (result) => result,
      skipKeyRecheck: true,
    }, this.loader));

    this.commands.register(routeCommand<{ id: string }, Awaited<ReturnType<WorkspaceThreadsService['get']>>>({
      key: 'thread.workspace.archive', variant: WORKSPACE_THREAD_ROUTE_VARIANTS.archive,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => {
        await this.workspace.archive(principal, input.id);
        return this.workspace.get(principal.id, input.id);
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
