/**
 * Review 1114 US-007 — writers of one project note slug that race, and the losers that recover.
 *
 * Two writers of one slug can both read no active row. Postgres then rejects the loser's insert against
 * `@@unique([projectId, activeKey])` (P2002) or, at `Serializable`, the read/write conflict itself (P2034),
 * and either way the loser's transaction is aborted. `PrismaMemoryItemRepository.upsert` re-runs the whole
 * attempt in a NEW transaction, up to `MEMORY_UPSERT_MAX_ATTEMPTS`, so the losing call still answers a stored
 * note instead of a 500.
 *
 * These cases use the real manager and the real database: the isolation level, the aborted transaction and
 * the rollback of a failed attempt are exactly what a mocked transaction manager cannot show.
 *
 * Run: cd apps/api && bun run test:db:up &&
 *      KODA_DB_TESTS=1 bunx vitest run test/integration/memory/memory-note-concurrent-upsert.integration.spec.ts
 */
import type { NathApplication } from '@nathapp/nestjs-app';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { MemoryKind } from '../../../src/common/enums';
import { Prisma } from '../../../src/generated/prisma/client';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** The slug every case races on, and therefore the one active key they share. */
const SLUG = 'replay-budget';
const ACTIVE_KEY = `NOTE:${SLUG}`;

describeIntegration('memory note concurrent upsert (review 1114 US-007)', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  /** The API's own repository, called as the system writer a direct upsert is made by. */
  let repository: PrismaMemoryItemRepository;
  /** The manager `upsert` retries on: a hook inside an attempt must see its transaction. */
  let tx: ITransactionManager;

  /** The note every case writes; each case changes what it is about. */
  const note = (over: Record<string, unknown> = {}) => ({
    projectId: world.projectId,
    kind: MemoryKind.NOTE,
    subject: SLUG,
    predicate: 'project',
    object: 'Budget stays 2,048 MiB.',
    description: 'replay budget',
    ...over,
  });
  /** The rows of this slug, oldest first. */
  const rowsOfSlug = () =>
    db.memoryItem.findMany({
      where: { projectId: world.projectId, subject: SLUG },
      orderBy: { createdAt: 'asc' },
    });
  /** The active row of the slug — the one the unique index allows. */
  const activeRowsOfSlug = () =>
    db.memoryItem.findMany({ where: { projectId: world.projectId, activeKey: ACTIVE_KEY } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    repository = asTestActor(app.get(PrismaMemoryItemRepository), { type: 'SYSTEM', id: 'outbox' });
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER);
  }, 120000);

  beforeEach(async () => {
    // Each case writes the rows it reads: every case below races on the same slug on purpose.
    await db.memoryItem.deleteMany({ where: { projectId: world.projectId } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-11: three identical concurrent writers all resolve and leave exactly one active row', async () => {
    const input = note();

    const results = await Promise.all([
      repository.upsert(input),
      repository.upsert(input),
      repository.upsert(input),
    ]);

    // The losers recover into the no-op restatement path, so every caller gets the stored note back rather
    // than a unique-violation 500.
    expect(results).toHaveLength(3);
    for (const item of results) expect(item.activeKey).toBe(ACTIVE_KEY);

    const active = await activeRowsOfSlug();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ status: 'active', description: 'replay budget' });
    // Identical restatements supersede nothing, so the slug is one row in total.
    expect(await rowsOfSlug()).toHaveLength(1);
  });

  it('AC-12: two concurrent writers with different descriptions leave one active and one superseded row', async () => {
    const original = note();
    const revised = note({ description: 'replay budget, revised' });

    const [first, second] = await Promise.all([
      repository.upsert(original),
      repository.upsert(revised),
    ]);

    expect(first.id).toBeTruthy();
    expect(second.id).toBeTruthy();

    const active = await activeRowsOfSlug();
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('active');

    const rows = await rowsOfSlug();
    expect(rows).toHaveLength(2);
    const superseded = rows.filter((row) => row.status === 'superseded');
    expect(superseded).toHaveLength(1);
    // The loser supersedes the row it found on its second attempt, and clears the key it no longer owns.
    expect(superseded[0].activeKey).toBeNull();
    expect(active[0].id).not.toBe(superseded[0].id);
    // One of the two answers is the row that ended up superseded: the retry, not the first attempt, decided it.
    expect([first.id, second.id]).toEqual(expect.arrayContaining([active[0].id, superseded[0].id]));
  });

  it('reruns a retried attempt\'s hooks inside its own transaction, so the failed attempt writes nothing', async () => {
    const seen: boolean[] = [];
    let attempts = 0;
    const onWritten = async (): Promise<void> => {
      attempts += 1;
      // The hook of an attempt runs inside that attempt's transaction — never outside it, where a retry
      // would leave the first attempt's insert committed.
      seen.push(tx.isInTransaction());
      if (attempts === 1) {
        // The error a lost race raises, so the retry is deterministic instead of a timing race.
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['projectId', 'activeKey'] },
        });
      }
    };

    const item = await repository.upsert(note(), { onWritten });

    expect(attempts).toBe(2);
    expect(seen).toEqual([true, true]);
    const rows = await rowsOfSlug();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: item.id, status: 'active', activeKey: ACTIVE_KEY });
  });
});
