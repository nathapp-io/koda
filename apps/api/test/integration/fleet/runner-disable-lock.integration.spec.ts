import type { NathApplication } from '@nathapp/nestjs-app';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { RunnersService } from '../../../src/fleet/runners/runners.service';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetBase } from '../../helpers/fleet-fixtures';
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
 *
 * Review B4: that edit lock is `FOR NO KEY UPDATE`, not `FOR UPDATE`. `FOR UPDATE` conflicts with the `FOR KEY SHARE`
 * lock a foreign-key check takes on the runner row when a concurrent transaction inserts the CANCEL command of a job
 * it holds: the disable waits for that job row while the cancellation waits for the runner's key-share lock. `FOR NO
 * KEY UPDATE` still conflicts with placement's `FOR UPDATE`, so B1's serialisation is kept.
 */
describeIntegration('RunnersService.update serialises on the runner row (review B1/B4)', () => {
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
      // waits at the ancestor's SELECT ... FOR NO KEY UPDATE, which is what makes the read serialised. The window is
      // short so both transactions stay inside the transaction manager's own timeout.
      await vi.waitFor(async () => {
        const blocked = await blockedQueries();
        expect(blocked.some((query) => query.includes('FOR NO KEY UPDATE'))).toBe(true);
      }, { timeout: 2_000, interval: 20 });
    } finally {
      release();
      await Promise.all([disable, enable]);
    }
    expect(await db.runner.findUnique({ where: { id } })).toMatchObject({ enabled: true });
  });

  it('an edit lock does not block the command foreign key a concurrent cancellation takes (review B4)', async () => {
    const base = await seedFleetBase(db);
    const { id: runnerId } = await insertRunner(db, { enabled: true, createdById: base.adminId });
    const newJob = (feature: string, over: Record<string, unknown>) => db.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'RUN', feature, profiles: [],
        maxCostUsd: 5, selectorLabels: [], requestedById: base.adminId, ...over,
      },
    });
    // The disable sweeps this held job: its transaction inserts a CANCEL command for the runner in the same transaction.
    await newJob('b4-held', { state: 'RUNNING', runnerId, leaseEpoch: 3, firstStartedAt: new Date() });
    // Another job's command insert takes the runner's `FOR KEY SHARE` lock from the FK check, and locks no row the
    // disable holds, so the only thing that can block it is the runner-row lock mode.
    const other = await newJob('b4-other', { state: 'QUEUED' });

    const recorder = app.get(AuditRecorder);
    const record = recorder.record.bind(recorder);
    let signalHeld!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { signalHeld = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    // Hold the disable open after it wrote `enabled: false` and queued the CANCEL command: it is the runner lock holder.
    vi.spyOn(recorder, 'record').mockImplementationOnce(async (entry) => {
      await record(entry);
      signalHeld();
      await released;
    });

    const disable = asUser(() => service.update('u1', runnerId, { enabled: false }));
    await held;
    const insert = db.fleetCommand.create({ data: { runnerId, jobId: other.id, type: 'CANCEL', leaseEpoch: 0, payload: {} } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: 'inserted' | 'blocked';
    try {
      // With `FOR UPDATE` the FK check waits on this transaction and never resolves; `FOR NO KEY UPDATE` lets it through.
      outcome = await Promise.race([
        insert.then(() => 'inserted' as const),
        new Promise<'blocked'>((resolve) => { timer = setTimeout(() => resolve('blocked'), 1_500); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await disable;
      await insert.catch(() => undefined);
    }
    expect(outcome).toBe('inserted');
  }, 20_000);
});
