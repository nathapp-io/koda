import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import type { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { PermissionService } from '../../permissions/permission.service';
import type { ThreadsService } from './threads.service';
import { ThreadRouteCommands, THREAD_ROUTE_VARIANTS } from './thread-route.commands';

describe('ThreadRouteCommands', () => {
  function build() {
    const registry = new ApprovalCommandRegistry();
    const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
    const loader = { forContext: vi.fn().mockResolvedValue(principal) };
    const threads = { create: vi.fn().mockResolvedValue({ id: 't1' }), updateCap: vi.fn().mockResolvedValue({ id: 't1' }), archive: vi.fn(), get: vi.fn().mockResolvedValue({ id: 't1', status: 'ARCHIVED' }), plan: vi.fn().mockResolvedValue({ job: { id: 'j1' } }), run: vi.fn().mockResolvedValue({ job: { id: 'j2' } }), stop: vi.fn().mockResolvedValue(undefined), endSession: vi.fn().mockResolvedValue(undefined), answer: vi.fn().mockResolvedValue(undefined), publish: vi.fn().mockResolvedValue({ jobId: 'jp1' }), discard: vi.fn().mockResolvedValue({ jobId: 'jd1' }) };
    const sendResult = { message: { id: 'm1' }, jobId: 'j1', deduplicated: false };
    const mutate = vi.fn().mockResolvedValue(sendResult);
    const messageThreads = { ...threads, sendMessage: vi.fn().mockResolvedValue(sendResult), prepareSendMessage: vi.fn().mockResolvedValue(mutate) };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: false }) };
    new ThreadRouteCommands(registry, messageThreads as unknown as ThreadsService, permissions as unknown as PermissionService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, threads: messageThreads, permissions, principal, loader, mutate };
  }

  it('message AC-9: registers the send REST variant with preparation', () => {
    const { registry } = build();
    expect(registry.get('thread.message.send', 'rest:threads.message')).toMatchObject({ key: 'thread.message.send', prepare: expect.any(Function) });
  });

  it('message execution rebuilds authority on both paths and defers only the mutation', async () => {
    const { registry, threads, permissions, principal, mutate } = build();
    const command = registry.get('thread.message.send', THREAD_ROUTE_VARIANTS.message);
    if (!command?.prepare) throw new Error('Missing message preparation');
    const message = { text: 'hi', clientMessageId: 'c1' };
    const input = command.parse({ slug: 'web', projectId: 'p1', id: 't1', message });
    permissions.can.mockResolvedValue({ allowed: true });
    const callback = await command.prepare(input);
    expect(permissions.can).toHaveBeenCalledWith(principal, 'thread.message.send', { projectId: 'p1' });
    expect(threads.prepareSendMessage).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', message, true);
    expect(mutate).not.toHaveBeenCalled();
    await callback();
    expect(mutate).toHaveBeenCalledOnce();
    expect(threads.sendMessage).not.toHaveBeenCalled();
    permissions.can.mockResolvedValue({ allowed: false });
    await command.execute(input);
    expect(threads.sendMessage).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', message, false);
    expect(command.parse({ slug: 'web', projectId: 'p1', id: 't1' })).toMatchObject({ message: {} });
    expect(() => command.parse({ slug: '', projectId: 'p1', id: 't1', message })).toThrow(ValidationAppException);
  });

  it('message AC-10: stores only message and jobId', () => {
    const { registry } = build();
    const command = registry.get('thread.message.send', 'rest:threads.message');
    expect(command?.toResult?.({ message: { id: 'm1' }, jobId: 'j1', deduplicated: false })).toEqual({ message: { id: 'm1' }, jobId: 'j1' });
  });

  it('AC-9: registers the three REST variants', () => {
    const { registry } = build();
    for (const [key, variant] of [['thread.create', THREAD_ROUTE_VARIANTS.create], ['thread.cap.update', THREAD_ROUTE_VARIANTS.update], ['thread.archive', THREAD_ROUTE_VARIANTS.archive]]) {
      expect(registry.get(key, variant)).toMatchObject({ key, variant });
    }
  });

  it('AC-7: registers stop, end-session and answer REST variants', () => {
    const { registry } = build();
    expect(registry.get('thread.stop', THREAD_ROUTE_VARIANTS.stop)).toMatchObject({ key: 'thread.stop', variant: 'rest:threads.stop' });
    expect(registry.get('thread.end-session', THREAD_ROUTE_VARIANTS.endSession)).toMatchObject({ key: 'thread.end-session', variant: 'rest:threads.end-session' });
    expect(registry.get('thread.answer', THREAD_ROUTE_VARIANTS.answer)).toMatchObject({ key: 'thread.answer', variant: 'rest:threads.answer' });
  });

  it('AC-8: recomputes thread.answer authority and passes its validated request to the service', async () => {
    const { registry, threads, permissions, principal } = build();
    const command = registry.get('thread.answer', THREAD_ROUTE_VARIANTS.answer);
    if (!command) throw new Error('Missing answer command');
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 't1', answer: { requestId: 'q1', text: 'yes' } }));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'thread.answer', { projectId: 'p1' });
    expect(threads.answer).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', { requestId: 'q1', text: 'yes' }, false);
    expect(command.toResult?.(result)).toEqual({});
  });

  it('AC-7: registers plan and run REST variants', () => {
    const { registry } = build();
    expect(registry.get('thread.plan', THREAD_ROUTE_VARIANTS.plan)).toMatchObject({ key: 'thread.plan', variant: 'rest:threads.plan' });
    expect(registry.get('thread.run', THREAD_ROUTE_VARIANTS.run)).toMatchObject({ key: 'thread.run', variant: 'rest:threads.run' });
  });

  it('AC-8: recomputes thread.run authority and passes the validated request to the service', async () => {
    const { registry, threads, permissions, principal } = build();
    permissions.can.mockResolvedValue({ allowed: true });
    const command = registry.get('thread.run', THREAD_ROUTE_VARIANTS.run);
    if (!command) throw new Error('Missing run command');
    const input = { slug: 'web', projectId: 'p1', id: 't1', run: { maxCostUsd: 3 } };
    const result = await command.execute(command.parse(input));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'thread.run', { projectId: 'p1' });
    expect(threads.run).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', { maxCostUsd: 3 }, true);
    expect(command.toResult?.(result)).toEqual({ job: { id: 'j2' } });
  });

  it('AC-10: recomputes requester authority for cap update at execution', async () => {
    const { registry, threads, permissions, principal } = build();
    const command = registry.get('thread.cap.update', THREAD_ROUTE_VARIANTS.update);
    if (!command) throw new Error('Missing update command');
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 't1', patch: { maxCostUsd: 7 } }));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'thread.cap.update', { projectId: 'p1' });
    expect(threads.updateCap).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', 7, false);
    expect(command.toResult?.(result)).toEqual({ id: 't1' });
  });

  it('creates as the rebuilt requester and validates frozen bodies and ids', async () => {
    const { registry, threads, loader } = build();
    const command = registry.get('thread.create', THREAD_ROUTE_VARIANTS.create);
    if (!command) throw new Error('Missing create command');
    const thread = { kind: 'REPO', repoId: 'r1', feature: 'unique', title: 'Unique', backend: { kind: 'native', model: 'm1' } };
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', thread }));
    expect(loader.forContext).toHaveBeenCalledOnce();
    expect(threads.create).toHaveBeenCalledWith('p1', 'a1', thread);
    expect(command.toResult?.(result)).toEqual({ id: 't1' });
    for (const input of [null, {}, { slug: 'web', projectId: '' }, { slug: 'web', projectId: 'p1', thread: [] }]) expect(() => command.parse(input)).toThrow(ValidationAppException);
    // Domain validation stays in the service, including when the frozen body is missing.
    expect(command.parse({ slug: 'web', projectId: 'p1' })).toMatchObject({ thread: {} });
  });

  it('AC-6: registers publish and discard REST variants', () => {
    const { registry } = build();
    expect(registry.get('thread.publish', THREAD_ROUTE_VARIANTS.publish)).toMatchObject({ key: 'thread.publish', variant: 'rest:threads.publish' });
    expect(registry.get('thread.discard', THREAD_ROUTE_VARIANTS.discard)).toMatchObject({ key: 'thread.discard', variant: 'rest:threads.discard' });
  });

  it('AC-7: recomputes publish authority and calls publish with requester identity', async () => {
    const { registry, threads, permissions, principal } = build();
    permissions.can.mockResolvedValue({ allowed: true });
    const command = registry.get('thread.publish', THREAD_ROUTE_VARIANTS.publish);
    if (!command) throw new Error('Missing publish command');
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 't1' }));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'thread.publish', { projectId: 'p1' });
    expect(threads.publish).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', true);
    expect(command.toResult?.(result)).toEqual({ jobId: 'jp1' });
  });

  it('recomputes discard authority and calls discard with requester identity', async () => {
    const { registry, threads, permissions, principal } = build();
    const command = registry.get('thread.discard', THREAD_ROUTE_VARIANTS.discard);
    if (!command) throw new Error('Missing discard command');
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 't1' }));
    expect(permissions.can).toHaveBeenCalledExactlyOnceWith(principal, 'thread.discard', { projectId: 'p1' });
    expect(threads.discard).toHaveBeenCalledExactlyOnceWith('p1', 't1', 'a1', false);
    expect(command.toResult?.(result)).toEqual({ jobId: 'jd1' });
  });

  it('archives before reading and stores the archived detail', async () => {
    const { registry, threads, permissions, principal } = build();
    permissions.can.mockResolvedValue({ allowed: true });
    const command = registry.get('thread.archive', THREAD_ROUTE_VARIANTS.archive);
    if (!command) throw new Error('Missing archive command');
    const result = await command.execute(command.parse({ slug: 'web', projectId: 'p1', id: 't1' }));
    expect(permissions.can).toHaveBeenCalledWith(principal, 'thread.archive', { projectId: 'p1' });
    expect(threads.archive).toHaveBeenCalledWith('p1', 't1', 'a1', true);
    expect(threads.get).toHaveBeenCalledWith('p1', 't1');
    expect(threads.archive.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(threads.get.mock.invocationCallOrder[0] ?? 0);
    expect(command.toResult?.(result)).toEqual({ id: 't1', status: 'ARCHIVED' });
  });
});
