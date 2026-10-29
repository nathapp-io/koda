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
    const threads = { create: vi.fn().mockResolvedValue({ id: 't1' }), updateCap: vi.fn().mockResolvedValue({ id: 't1' }), archive: vi.fn(), get: vi.fn().mockResolvedValue({ id: 't1', status: 'ARCHIVED' }) };
    const permissions = { can: vi.fn().mockResolvedValue({ allowed: false }) };
    new ThreadRouteCommands(registry, threads as unknown as ThreadsService, permissions as unknown as PermissionService, loader as unknown as ActorPrincipalLoader).onModuleInit();
    return { registry, threads, permissions, principal, loader };
  }

  it('AC-9: registers the three REST variants', () => {
    const { registry } = build();
    for (const [key, variant] of [['thread.create', THREAD_ROUTE_VARIANTS.create], ['thread.cap.update', THREAD_ROUTE_VARIANTS.update], ['thread.archive', THREAD_ROUTE_VARIANTS.archive]]) {
      expect(registry.get(key, variant)).toMatchObject({ key, variant });
    }
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
