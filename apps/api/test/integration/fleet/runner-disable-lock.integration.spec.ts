import type { NathApplication } from '@nathapp/nestjs-app';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { RunnersService } from '../../../src/fleet/runners/runners.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

/**
 * Review B1: disabling a runner decides whether to cancel its held jobs from the `enabled` value it read. With an
 * unlocked read, a concurrent enable (and the placement that follows it) can commit between that read and the
 * `enabled: false` write, so the disable silently skips the job the enable just placed. `RunnersService.update` now
 * takes the runner row lock first — the same `FOR UPDATE` placement takes before it re-reads `enabled` — so the read
 * is the state the transaction writes from.
 */
describeIntegration('RunnersService.update serialises on the runner row (review B1)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let service: RunnersService;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    service = app.get(RunnersService, { strict: false });
  });
  afterAll(async () => { await app?.close(); });
  afterEach(() => vi.restoreAllMocks());

  const asUser = <T>(fn: () => Promise<T>) => withTestActor({ type: 'USER', id: 'u1' }, fn);

  /** Other backends waiting on a row lock, with the statement they are blocked in. */
  const blockedQueries = async (): Promise<string[]> => {
    const rows = await db.$queryRaw<Array<{ query: string }>>`
      SELECT query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND query LIKE '%"Runner"%'
    `;
    return rows.map((row) => row.query);
  };

  it('a concurrent enable waits on the runner-row lock before it reads enabled', async () => {
    const { id } = await insertRunner(db, { enabled: true });
    const recorder = app.get(AuditRecorder);
    const record = recorder.record.bind(recorder);
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    // Hold the disable open after the row is written and locked: its transaction is still the lock holder.
    vi.spyOn(recorder, 'record').mockImplementationOnce(async (entry) => {
      await record(entry);
      signalHeld();
      await released;
    });

    const disable = asUser(() => service.update('u1', id, { enabled: false }));
    await held;
    const enable = asUser(() => service.update('u1', id, { enabled: true }));
    try {
      // Before the fix the enable reaches its own UPDATE on the still-enabled row after a stale read; afterwards it
      // waits at the ancestor's SELECT ... FOR UPDATE, which is what makes the read serialised. The window is short so
      // both transactions stay inside the transaction manager's own timeout.
      await vi.waitFor(async () => {
        const blocked = await blockedQueries();
        expect(blocked.some((query) => query.includes('FOR UPDATE'))).toBe(true);
      }, { timeout: 2_000, interval: 20 });
    } finally {
      release();
      await Promise.all([disable, enable]);
    }
    expect(await db.runner.findUnique({ where: { id } })).toMatchObject({ enabled: true });
  });
});
