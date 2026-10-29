import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RequiresMetadata, REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { ProjectMembershipGuard } from '../../projects/project-membership.guard';
import { ThreadsController } from './threads.controller';

/**
 * Permissions P1 US-002: the route half of the project thread migration, pinned per handler.
 *
 * This is the brief's table in executable form: each of the fourteen project thread handlers declares
 * exactly the catalog keys the story names, `plan` and `run` demand `fleet.job.dispatch` as well
 * (`mode: 'all'`, the default), and every handler lists `ProjectMembershipGuard, RequiresGuard` in that
 * order — the membership guard resolves `request.projectContext` before the key check.
 *
 * It cannot pass on the pre-change controller: no handler carried `@Requires` metadata at all (the
 * guards were a class-level `ProjectMembershipGuard` plus an inline CASL check), so the metadata read
 * below answered `undefined` for every route.
 */
describe('ThreadsController route keys (US-002)', () => {
  type Handler = keyof ThreadsController;
  const metadataOf = (handler: Handler): RequiresMetadata | undefined =>
    Reflect.getMetadata(REQUIRES_METADATA, ThreadsController.prototype[handler] as object) as RequiresMetadata | undefined;
  const guardsOf = (handler: Handler): unknown[] =>
    (Reflect.getMetadata(GUARDS_METADATA, ThreadsController.prototype[handler] as object) ?? []) as unknown[];

  /** The brief's route/key table, in its order. `mode` is the decorator default (`all`) unless stated. */
  const TABLE: ReadonlyArray<{ handler: Handler; keys: string[]; mode?: 'all' }> = [
    { handler: 'create', keys: ['thread.create'] },
    { handler: 'list', keys: ['thread.read'] },
    { handler: 'get', keys: ['thread.read'] },
    { handler: 'messages', keys: ['thread.read'] },
    { handler: 'update', keys: ['thread.cap.update'] },
    { handler: 'plan', keys: ['thread.plan', 'fleet.job.dispatch'] },
    { handler: 'run', keys: ['thread.run', 'fleet.job.dispatch'] },
    { handler: 'stop', keys: ['thread.stop'] },
    { handler: 'endSession', keys: ['thread.end-session'] },
    { handler: 'answer', keys: ['thread.answer'] },
    { handler: 'archive', keys: ['thread.archive'] },
    { handler: 'publish', keys: ['thread.publish'] },
    { handler: 'discard', keys: ['thread.discard'] },
    { handler: 'sendMessage', keys: ['thread.message.send'] },
  ];

  it.each(TABLE)('$handler declares its catalog key(s) at the guard', ({ handler, keys, mode }) => {
    const meta = metadataOf(handler);

    expect(meta?.keys).toEqual(keys);
    expect(meta?.mode).toBe(mode ?? 'all');
    expect(meta?.enforcedBy).toBe('guard');
  });

  it.each(TABLE)('$handler runs ProjectMembershipGuard before RequiresGuard', ({ handler }) => {
    expect(guardsOf(handler)).toEqual([ProjectMembershipGuard, RequiresGuard]);
  });

  it('covers every public handler of the controller, so a new route cannot skip the table', () => {
    const handlers = Object.getOwnPropertyNames(ThreadsController.prototype)
      .filter((name) => name !== 'constructor' && name !== 'canOperate')
      .sort();
    expect(handlers).toEqual(TABLE.map((row) => row.handler).sort());
  });

  it('keeps the CASL factory out of the controller: PermissionService is the authorization dependency', () => {
    const deps = Reflect.getMetadata('design:paramtypes', ThreadsController) as unknown[];

    expect(deps.map((dep) => (dep as { name: string }).name)).toEqual(['ThreadsService', 'PermissionService', 'ApprovalRouteGate']);
  });
});
