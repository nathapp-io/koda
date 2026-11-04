import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../../generated/prisma/client';
import { withCommittedEffects } from '../../common/committed-effects';
import { ThreadEventBus } from '../../live/thread-event-bus';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { ThreadsController } from './threads.controller';
import { ThreadRouteCommands } from './thread-route.commands';
import { ThreadsService } from './threads.service';
import { PrismaChatThreadRepository } from './prisma-chat-thread.repository';
import type { ThreadMode } from '../common/thread-jobs';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';

const principal = { id: 'U', actorType: 'user', role: 'MEMBER', email: 'u@test', name: 'Stale name', blacklisted: false, revoked: false, authorities: [] } satisfies UserPrincipal;
const ctx = { project: { id: 'P', slug: 'web' } };
function fixture() {
  const row = { id: 'T', kind: 'REPO', projectId: 'P', repoId: 'repo', baseRef: 'main', feature: 'f', specPath: 'spec.md', createdById: 'U', createdByType: 'USER', mode: 'read', runnerId: null as string | null, status: 'ACTIVE', maxCostUsd: new Prisma.Decimal(5), costUsd: new Prisma.Decimal(0), backend: { kind: 'native' }, skills: [] };
  const client = {
    chatThread: { findFirst: vi.fn().mockImplementation(async () => row), update: vi.fn().mockImplementation(async ({ data }) => ({ ...row, ...data })) },
    fleetJob: { findFirst: vi.fn().mockResolvedValue(null) },
    fleetCommand: { findFirst: vi.fn().mockResolvedValue(null) },
    runner: { findUnique: vi.fn().mockResolvedValue({ lastSeenAt: new Date(), protocolVersion: 4 }) },
    chatMessage: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'M' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ name: 'Current name', email: 'u@test' }) },
    agent: { findUnique: vi.fn().mockResolvedValue({ name: 'Current agent', slug: 'agent' }) },
    $queryRaw: vi.fn().mockResolvedValue([{ nextSeq: 4 }]),
  };
  const prisma = createMockPrismaService({ fn: vi.fn });
  Object.assign(prisma, { client });
  const jobs = { lockById: vi.fn(), createCommand: vi.fn() };
  const audit = { record: vi.fn() };
  const notifier = { notify: vi.fn() };
  const bus = new ThreadEventBus();
  const publish = vi.spyOn(bus, 'publish');
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const repo = new PrismaChatThreadRepository(prisma as never, jobs as never, tx as never, {} as never, {} as never, notifier as never, { snapshot: async () => ({ match: () => null }) } as never, { threadsEnabled: true, runnerOfflineSec: 120 } as never, audit as never, bus);
  const permissions = { can: vi.fn().mockResolvedValue({ allowed: true }) };
  const service = new ThreadsService(repo, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, permissions as never);
  const change = (mode: ThreadMode = 'ask', who = principal) => service.changeMode('P', 'T', who, mode);
  const live = (state = 'RUNNING', action = 'SESSION') => {
    row.runnerId = 'R';
    client.fleetJob.findFirst.mockResolvedValue({ id: 'J', command: 'THREAD', state, runnerId: 'R', leaseEpoch: 7, threadTurn: { action } });
  };
  return { row, client, jobs, audit, notifier, publish, repo, service, permissions, change, live, tx };
}

describe('thread mode changes', () => {
  it('AC-1/13: persists the mode, complete system message and target-key audit atomically', async () => {
    const f = fixture();
    expect(await f.change()).toMatchObject({ mode: 'ask' });
    expect(f.client.chatMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({ threadId: 'T', seq: 4, role: 'system', status: 'complete', content: 'Mode changed from read to ask by Current name' }) });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'thread.mode.ask', summary: expect.stringContaining('read to ask') }));
    expect(f.client.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'U' } }));
    expect(f.jobs.createCommand).not.toHaveBeenCalled();
    expect(f.tx.run).toHaveBeenCalledOnce();
    expect(f.publish.mock.calls.map(([event]) => event.type)).toEqual(['message', 'thread']);
  });
  it('AC-2: denies the target full key even to the creator', async () => {
    const f = fixture();
    f.permissions.can.mockImplementation(async (_p, key) => ({ allowed: key !== 'thread.mode.full' }));
    await expect(f.change('full')).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('AC-3: any-row cap holder changes another creator thread to full', async () => {
    const f = fixture();
    expect(await f.change('full', { ...principal, id: 'admin' })).toMatchObject({ mode: 'full' });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'thread.mode.full' }));
  });
  it('AC-4: ask alone does not authorize a different creator', async () => {
    const f = fixture();
    f.permissions.can.mockImplementation(async (_p, key) => ({ allowed: key === 'thread.mode.ask' }));
    await expect(f.change('ask', { ...principal, id: 'other' })).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('AC-5: own-only cap holder can return their own thread to read', async () => {
    const f = fixture();
    f.row.mode = 'ask';
    f.permissions.can.mockImplementation(async (_p, key, scope) => ({ allowed: key === 'thread.cap.update' && scope.resource?.createdBy?.id === 'U' }));
    expect(await f.change('read')).toMatchObject({ mode: 'read' });
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'thread.cap.update' }));
  });
  it.each(['QUEUED', 'ASSIGNED'])('AC-6: %s session refuses without writes', async state => {
    const f = fixture(); f.live(state);
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.turnRunning', httpStatus: 409 });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
    expect(f.jobs.createCommand).not.toHaveBeenCalled();
  });
  it('AC-7: a running turn refuses without writes', async () => {
    const f = fixture(); f.live(); f.client.chatMessage.findFirst.mockResolvedValue({ id: 'in-flight' });
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.turnRunning', httpStatus: 409 });
    expect(f.audit.record).not.toHaveBeenCalled();
  });
  it.each(['PUBLISH', 'DISCARD'])('AC-8: active %s refuses as busy', async action => {
    const f = fixture(); f.live('QUEUED', action);
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.busy', httpStatus: 409 });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('AC-9: idle session closes once under job-before-thread locks', async () => {
    const f = fixture(); f.live();
    await f.change();
    expect(f.jobs.createCommand).toHaveBeenCalledExactlyOnceWith({ runnerId: 'R', jobId: 'J', leaseEpoch: 7, type: 'THREAD_CLOSE', payload: {} });
    expect(f.jobs.lockById.mock.invocationCallOrder[0]).toBeLessThan(f.client.$queryRaw.mock.invocationCallOrder[0] ?? 0);
    expect(f.notifier.notify).toHaveBeenCalledExactlyOnceWith('R');
  });
  it('AC-10: closing session changes mode without a second close', async () => {
    const f = fixture(); f.live(); f.client.fleetCommand.findFirst.mockResolvedValue({ id: 'close' });
    expect(await f.change()).toMatchObject({ mode: 'ask' });
    expect(f.jobs.createCommand).not.toHaveBeenCalled();
  });
  it('AC-11: current-mode response writes no note, audit or command', async () => {
    const f = fixture(); f.live();
    expect(await f.change('read')).toMatchObject({ mode: 'read' });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
    expect(f.client.chatMessage.create).not.toHaveBeenCalled();
    expect(f.jobs.createCommand).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('publishes live events only after the outer transaction has committed', async () => {
    const f = fixture(); f.live();
    await withCommittedEffects(async () => {
      await f.change();
      expect(f.publish).not.toHaveBeenCalled();
    });
    expect(f.publish).toHaveBeenCalledTimes(2);
  });
  it('rejects a new active job observed only under the thread lock', async () => {
    const f = fixture(); f.live();
    f.client.fleetJob.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.busy' });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('rechecks creator and scope after locking', async () => {
    const f = fixture(); f.permissions.can.mockImplementation(async (_p, key) => ({ allowed: key === 'thread.mode.ask' }));
    f.client.chatThread.findFirst.mockResolvedValueOnce(f.row).mockResolvedValueOnce(f.row).mockResolvedValueOnce({ ...f.row, createdById: 'other' });
    await expect(f.change()).rejects.toBeInstanceOf(ForbiddenAppException);
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('does not let offline/cost-cap send refusals hide a running turn', async () => {
    const f = fixture(); f.live(); f.row.costUsd = new Prisma.Decimal(5);
    f.client.chatMessage.findFirst.mockResolvedValue({ id: 'in-flight' });
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.turnRunning' });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
  it('does not send a second close to an uploading session', async () => {
    const f = fixture(); f.live('UPLOADING');
    expect(await f.change()).toMatchObject({ mode: 'ask' });
    expect(f.jobs.createCommand).not.toHaveBeenCalled();
  });
  it('suppresses all live effects if the outer approval transaction rolls back', async () => {
    const f = fixture(); f.live();
    await expect(withCommittedEffects(async () => { await f.change(); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(f.notifier.notify).toHaveBeenCalledOnce(); // notifier itself defers its wake; mocked here
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('rolls no live events out when audit fails', async () => {
    const f = fixture(); f.live(); f.audit.record.mockRejectedValue(new Error('audit unavailable'));
    await expect(f.change()).rejects.toThrow('audit unavailable');
    expect(f.publish).not.toHaveBeenCalled(); expect(f.notifier.notify).not.toHaveBeenCalled();
  });
  it.each(['PROJECT', 'WORKSPACE'])('refuses non-read on %s with mode validation', async kind => {
    const f = fixture(); f.row.kind = kind;
    await expect(f.change()).rejects.toMatchObject({ prefix: 'threads.input' });
    expect(f.client.chatThread.update).not.toHaveBeenCalled();
  });
});

describe('mode approval route and replay', () => {
  it.each([['read', 'thread.cap.update'], ['ask', 'thread.mode.ask'], ['full', 'thread.mode.full']] as const)('gates %s under the target key', async (mode, key) => {
    const gate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { mode } }) };
    const controller = new ThreadsController({} as never, gate as never);
    await controller.changeMode('T', { mode }, ctx, principal);
    expect(gate.run).toHaveBeenCalledExactlyOnceWith({ key, variant: 'rest:threads.mode', projectId: 'P', input: { slug: 'web', projectId: 'P', id: 'T', mode } });
  });
  it('AC-12: pending does not execute the mode mutation', async () => {
    const changeMode = vi.fn();
    const controller = new ThreadsController({ changeMode } as never, { run: vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'approval' } }) } as never);
    await expect(controller.changeMode('T', { mode: 'ask' }, ctx, principal)).rejects.toBeInstanceOf(ApprovalPending);
    expect(changeMode).not.toHaveBeenCalled();
  });
  it('AC-14: invalid mode names the field before opening approval', async () => {
    const run = vi.fn(); const controller = new ThreadsController({} as never, { run } as never);
    await expect(controller.changeMode('T', { mode: 'bogus' as ThreadMode }, ctx, principal)).rejects.toMatchObject({ prefix: 'threads.input', response: expect.objectContaining({ args: { reason: 'mode' } }) });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['thread.cap.update', 'thread.mode.ask', 'thread.mode.full'])('registers replay under %s and rechecks the requester', async key => {
    const registry = new ApprovalCommandRegistry();
    const changeMode = vi.fn().mockResolvedValue({ mode: 'ask' });
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    new ThreadRouteCommands(registry, { changeMode } as never, {} as never, loader as never).onModuleInit();
    const command = registry.get(key, 'rest:threads.mode');
    expect(command).toBeDefined();
    if (!command) throw new Error('Missing mode command');
    await command.execute(command.parse({ slug: 'web', projectId: 'P', id: 'T', mode: 'ask' }));
    expect(changeMode).toHaveBeenCalledExactlyOnceWith('P', 'T', principal, 'ask');
    expect(loader.forContext).toHaveBeenCalledOnce();
  });
});
