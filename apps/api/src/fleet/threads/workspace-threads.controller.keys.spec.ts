import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RequiresMetadata, REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { WorkspaceThreadsController } from './workspace-threads.controller';
import { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';

/**
 * Permissions P1 US-003: the route half of the workspace thread migration, pinned per handler.
 *
 * The brief's table in executable form: the six no-row routes declare their workspace key at the
 * guard, and the four routes that act on one thread's own rows declare the project key
 * `enforcedBy: 'service'` — the handler cannot decide before it has loaded the thread, so
 * `WorkspaceThreadsService` asks for the key in the thread's home project with the thread's creator
 * as the resource.
 *
 * It cannot pass on the pre-change controller: no handler carried `@Requires` metadata (there was a
 * `user(principal)` helper refusing every non-user principal and no key check at all), so the
 * metadata read below answered `undefined` for every route and the handler list included `user`.
 */
describe('WorkspaceThreadsController route keys (US-003)', () => {
  type Handler = keyof WorkspaceThreadsController;
  const metadataOf = (handler: Handler): RequiresMetadata | undefined =>
    Reflect.getMetadata(REQUIRES_METADATA, WorkspaceThreadsController.prototype[handler] as object) as RequiresMetadata | undefined;
  const guardsOf = (handler: Handler): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, WorkspaceThreadsController.prototype[handler] as object) ?? []) as unknown[];

  /** The brief's route/key table, in its order. Every route is a single key, `mode` the default `all`. */
  const TABLE: ReadonlyArray<{ handler: Handler; keys: string[]; enforcedBy: 'guard' | 'service' }> = [
    { handler: 'create', keys: ['thread.workspace.create'], enforcedBy: 'guard' },
    { handler: 'list', keys: ['thread.workspace.read'], enforcedBy: 'guard' },
    { handler: 'get', keys: ['thread.workspace.read'], enforcedBy: 'guard' },
    { handler: 'messages', keys: ['thread.workspace.read'], enforcedBy: 'guard' },
    { handler: 'send', keys: ['thread.workspace.message.send'], enforcedBy: 'guard' },
    { handler: 'archive', keys: ['thread.workspace.archive'], enforcedBy: 'guard' },
    // The four S routes: the key is checked in the thread's home project, on the row the service loads.
    { handler: 'update', keys: ['thread.cap.update'], enforcedBy: 'service' },
    { handler: 'stop', keys: ['thread.stop'], enforcedBy: 'service' },
    { handler: 'endSession', keys: ['thread.end-session'], enforcedBy: 'service' },
    { handler: 'answer', keys: ['thread.answer'], enforcedBy: 'service' },
  ];

  it.each(TABLE)('$handler declares its catalog key at $enforcedBy', ({ handler, keys, enforcedBy }) => {
    const meta = metadataOf(handler);

    expect(meta?.keys).toEqual(keys);
    expect(meta?.mode).toBe('all');
    expect(meta?.enforcedBy).toBe(enforcedBy);
  });

  it.each(TABLE)('$handler runs RequiresGuard alone, with no project to resolve first', ({ handler }) => {
    expect(guardsOf(handler)).toEqual([RequiresGuard]);
  });

  it('covers every handler of the controller, so a new route cannot skip the table and the user helper is gone', () => {
    const handlers = Object.getOwnPropertyNames(WorkspaceThreadsController.prototype)
      .filter((name) => name !== 'constructor')
      .sort();
    expect(handlers).toEqual(TABLE.map((row) => row.handler).sort());
  });

  it('authorizes through keys only: PermissionService is the service\'s dependency, not the controller\'s', () => {
    const deps = Reflect.getMetadata('design:paramtypes', WorkspaceThreadsController) as unknown[];

    expect(deps.map((dep) => (dep as { name: string }).name)).toEqual(['WorkspaceThreadsService', 'ApprovalRouteGate']);
  });

  it('AC-9: routes create through the global approval gate with the body unchanged', async () => {
    const body = { title: 'thread', backend: { kind: 'native', model: 'm1' } };
    const run = vi.fn(async () => ({ status: 'executed' as const, result: { id: 't1' } }));
    const controller = new WorkspaceThreadsController({} as never, { run } as unknown as ApprovalRouteGate);

    await controller.create(body as never, { actorType: 'user', id: 'u', role: 'MEMBER' } as never);

    expect(run).toHaveBeenCalledWith({
      key: 'thread.workspace.create', variant: 'rest:workspace-threads.create', projectId: null, input: { thread: body },
    });
  });
});
