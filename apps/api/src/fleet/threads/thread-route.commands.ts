import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { PermissionService } from '../../permissions/permission.service';
import { ThreadsService } from './threads.service';
import { AnswerQuestionDto, CreateThreadDto, SendMessageDto, UpdateThreadDto } from './dto/thread.dto';
import { PlanThreadDto, RunThreadDto } from './dto/thread-handoff.dto';

export const THREAD_ROUTE_VARIANTS = {
  create: 'rest:threads.create',
  update: 'rest:threads.update',
  archive: 'rest:threads.archive',
  plan: 'rest:threads.plan',
  run: 'rest:threads.run',
  stop: 'rest:threads.stop',
  endSession: 'rest:threads.end-session',
  answer: 'rest:threads.answer',
  publish: 'rest:threads.publish',
  discard: 'rest:threads.discard',
  message: 'rest:threads.message',
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
    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; message: SendMessageDto }, Awaited<ReturnType<ThreadsService['sendMessage']>>>({
      key: 'thread.message.send', variant: THREAD_ROUTE_VARIANTS.message,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, message: parseBody(SendMessageDto, value.message ?? {}) };
      },
      prepare: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.message.send', { projectId: input.projectId })).allowed;
        return this.threads.prepareSendMessage(input.projectId, input.id, principal.id, input.message, canOperate);
      },
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.message.send', { projectId: input.projectId })).allowed;
        return this.threads.sendMessage(input.projectId, input.id, principal.id, input.message, canOperate);
      },
      toResult: ({ message, jobId }) => ({ message, jobId }),
    }, this.loader));

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

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; plan: PlanThreadDto }, Awaited<ReturnType<ThreadsService['plan']>>>({
      key: 'thread.plan', variant: THREAD_ROUTE_VARIANTS.plan,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, plan: parseBody(PlanThreadDto, value.plan ?? {}) };
      },
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.plan', { projectId: input.projectId })).allowed;
        return this.threads.plan(input.projectId, input.id, principal.id, input.plan, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; run: RunThreadDto }, Awaited<ReturnType<ThreadsService['run']>>>({
      key: 'thread.run', variant: THREAD_ROUTE_VARIANTS.run,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, run: parseBody(RunThreadDto, value.run ?? {}) };
      },
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.run', { projectId: input.projectId })).allowed;
        return this.threads.run(input.projectId, input.id, principal.id, input.run, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Record<string, never>>({
      key: 'thread.stop', variant: THREAD_ROUTE_VARIANTS.stop,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.stop', { projectId: input.projectId })).allowed;
        await this.threads.stop(input.projectId, input.id, principal.id, canOperate);
        return {};
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Record<string, never>>({
      key: 'thread.end-session', variant: THREAD_ROUTE_VARIANTS.endSession,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.end-session', { projectId: input.projectId })).allowed;
        await this.threads.endSession(input.projectId, input.id, principal.id, canOperate);
        return {};
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Awaited<ReturnType<ThreadsService['publish']>>>({
      key: 'thread.publish', variant: THREAD_ROUTE_VARIANTS.publish,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.publish', { projectId: input.projectId })).allowed;
        return this.threads.publish(input.projectId, input.id, principal.id, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string }, Awaited<ReturnType<ThreadsService['discard']>>>({
      key: 'thread.discard', variant: THREAD_ROUTE_VARIANTS.discard,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'id']),
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.discard', { projectId: input.projectId })).allowed;
        return this.threads.discard(input.projectId, input.id, principal.id, canOperate);
      },
      toResult: (result) => result,
    }, this.loader));

    this.commands.register(routeCommand<{ slug: string; projectId: string; id: string; answer: AnswerQuestionDto }, Record<string, never>>({
      key: 'thread.answer', variant: THREAD_ROUTE_VARIANTS.answer,
      parse: (input) => {
        const route = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const value = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
        return { ...route, answer: parseBody(AnswerQuestionDto, value.answer ?? {}) };
      },
      run: async (principal, input) => {
        const canOperate = (await this.permissions.can(principal, 'thread.answer', { projectId: input.projectId })).allowed;
        await this.threads.answer(input.projectId, input.id, principal.id, input.answer, canOperate);
        return {};
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
