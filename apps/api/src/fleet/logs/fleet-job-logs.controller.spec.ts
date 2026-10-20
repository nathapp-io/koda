import { REQUIRES_METADATA, type RequiresMetadata } from '../../permissions/requires.decorator';
import { FleetJobLogsController } from './fleet-job-logs.controller';

/**
 * Permissions P1d US-004: the log reads declare `fleet.job.logs.read` and keeps its 600/min throttle.
 *
 * The controllers no longer refuse by principal type (R10 retired): the key decides, and a rostered
 * agent holds it like a user. The allow and refuse cases are pinned over HTTP by
 * `test/integration/permissions/enforce-fleet-project-reads.integration.spec.ts`.
 */
describe('FleetJobLogsController permissions metadata (US-004)', () => {
  const handlers = (): Array<[string, object]> => [
    ['list', FleetJobLogsController.prototype.list as unknown as object],
    ['entries', FleetJobLogsController.prototype.entries as unknown as object],
    ['raw', FleetJobLogsController.prototype.raw as unknown as object],
  ];

  it.each(handlers())('%s declares @Requires fleet.job.logs.read, checked by RequiresGuard after membership', (_name, fn) => {
    expect(Reflect.getMetadata(REQUIRES_METADATA, fn) as RequiresMetadata).toEqual({
      keys: ['fleet.job.logs.read'],
      mode: 'all',
      enforcedBy: 'guard',
    });
    const guards = (Reflect.getMetadata('__guards__', fn) ?? []) as unknown[];
    expect(guards.map((guard) => (guard as { name?: string }).name)).toEqual([
      'ProjectMembershipGuard',
      'RequiresGuard',
    ]);
  });

  it('carries the class-level 600 requests per 60000 ms read throttle (R10, D331)', () => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', FleetJobLogsController)).toBe(600);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', FleetJobLogsController)).toBe(60000);
  });

  it('defaults entries to forward with limit 200 and parses numbers', async () => {
    const reads = { entries: vi.fn(async () => ({ entries: [] })) };
    const controller = new FleetJobLogsController(reads as never);
    const ctx = { project: { id: 'p1' } } as never;

    await controller.entries('j1', 'run', { cursor: '12', level: 'warn' } as never, ctx);

    expect(reads.entries).toHaveBeenCalledWith('p1', 'j1', 'run', {
      cursor: 12,
      level: 'warn',
      direction: 'forward',
      limit: 200,
    });
  });
});
