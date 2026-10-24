import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Branch review B1: recording a decision replaces the requester's previous decision on the same topic, and the
 * replacement is atomic — supersession and insertion happen in one transaction, so a replacement that fails leaves
 * the previous decision active exactly as it was.
 *
 * The failure is a real one, at the database: a temporary `CHECK` constraint refuses the object this spec asks the
 * replacement to store, so the insert of `upsert`'s serializable transaction raises inside that transaction. Every
 * query — the supersession, the insert, the rollback — is the repository's own work against real Postgres; nothing is
 * stubbed. Before the fix, `recordDecision` committed the supersession in a write of its own, so the previous decision
 * stayed superseded with no replacement, and the first test below failed.
 *
 * Each test uses its own topic and reads only that topic's rows, so the two are independent of their order.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/memory/decision-replacement-atomic.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { ExtractionService } from '../../../src/memory/extraction.service';
import { MemoryKind } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

/** The object the temporary constraint refuses: the replacement this spec makes fail. */
const REFUSED_OBJECT = 'koda-b1-refused-decision';
const CONSTRAINT = 'koda_b1_refused_object';

describeIntegration('ExtractionService.recordDecision replacement atomicity (B1)', () => {
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaMemoryItemRepository;
  let service: ExtractionService;
  let projectId: string;
  const actorId = 'user-atomic';

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(process.env.DATABASE_URL) } });
    await prismaService.onModuleInit();
    const prisma = prismaService.client;
    repo = new PrismaMemoryItemRepository(transactionManager(prisma), prismaService);
    service = new ExtractionService();
    projectId = (await prisma.project.create({ data: { name: 'Mem', slug: 'mem-atomic', key: 'MAT' } })).id;
    // The injected failure: only the object this spec refuses, so nothing else in the file is affected. Dropped first
    // in case an earlier, interrupted run left it behind (the truncating reset keeps constraints).
    await prisma.$executeRawUnsafe(`ALTER TABLE "MemoryItem" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MemoryItem" ADD CONSTRAINT "${CONSTRAINT}" CHECK (object IS DISTINCT FROM '${REFUSED_OBJECT}')`,
    );
  });

  afterAll(async () => {
    try {
      await prismaService?.client.$executeRawUnsafe(`ALTER TABLE "MemoryItem" DROP CONSTRAINT IF EXISTS "${CONSTRAINT}"`);
    } finally {
      await prismaService?.onModuleDestroy();
    }
  });

  /** The `DECISION` rows of one topic, in any status. */
  const rowsFor = (topic: string) =>
    prismaService.client.memoryItem.findMany({ where: { projectId, kind: MemoryKind.DECISION, predicate: topic } });

  /** One active decision of that topic, written the way an approval writes one. */
  const seedDecision = (topic: string, object: string, sourceId: string) =>
    repo.upsert({
      projectId,
      kind: MemoryKind.DECISION,
      subject: `agent:${actorId}`,
      predicate: topic,
      object,
      sourceType: 'decision_event',
      sourceId,
      confidence: 1.0,
      ownerId: actorId,
    });

  it('a failed replacement leaves the previous decision active and unchanged', async () => {
    const before = await seedDecision('db', 'use sqlite', 'dec-1');

    await expect(
      service.recordDecision(
        { projectId, actorId, topic: 'db', decision: REFUSED_OBJECT, sourceId: 'thread:t1' },
        repo,
      ),
    ).rejects.toThrow();

    const rows = await rowsFor('db');
    // One row, still the old one, still active: the supersession rolled back with the insert that never happened.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, object: 'use sqlite', status: 'active' });
    expect(rows[0]?.activeKey).not.toBeNull();
  });

  it('a replacement that succeeds supersedes the previous decision, leaving one active decision', async () => {
    const before = await seedDecision('cache', 'use redis', 'dec-2');

    const recorded = await service.recordDecision(
      { projectId, actorId, topic: 'cache', decision: 'use memory', sourceId: 'thread:t2' },
      repo,
    );

    const rows = await rowsFor('cache');
    expect(rows).toHaveLength(2);
    const active = rows.filter((row) => row.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ id: recorded.memoryId, object: 'use memory' });
    expect(rows.find((row) => row.id === before.id)).toMatchObject({ status: 'superseded', activeKey: null });
  });

  /** The transaction manager of a run with no ambient transaction: every call is its own. */
  function transactionManager(prisma: PrismaClient): ITransactionManager {
    return {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
  }
});
