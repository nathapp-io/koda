/**
 * Fleet S5a US-002 — ChatThread, ChatMessage, FleetThreadTurn, FleetJob.threadId and the
 * active (repoId, feature) partial unique index (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-chat-threads-schema.integration.spec.ts
 */
import { Prisma } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { applyMigration, scratchSchemaBefore, ScratchSchema } from '../../helpers/migration-schema';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
// The migration block replays every committed migration before the target; see the sibling
// fleet schema specs, which raise the hook timeout for the same reason.
vi.setConfig({ testTimeout: 20_000 });
const MIGRATION = '20261013090000_chat_threads';

describeIntegration('fleet chat threads schema (PG)', () => {
  const prisma = createTestPrismaClient();
  let base: Awaited<ReturnType<typeof seedFleetBase>>;

  const thread = (over: Partial<Prisma.ChatThreadUncheckedCreateInput> = {}) => prisma.chatThread.create({
    data: {
      projectId: base.projectId, repoId: base.repoId, baseRef: 'main', feature: 'auth', title: 't',
      createdById: base.adminId, backend: { kind: 'native', model: 'deepseek-v3' }, skills: [],
      specPath: '.nax/features/auth/spec.md', ...over,
    },
  });

  beforeAll(async () => {
    await resetDb();
    base = await seedFleetBase(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('allows one ACTIVE thread per repo and feature (US-002 AC8)', async () => {
    await thread({ feature: 'dup-active' });
    await expect(thread({ feature: 'dup-active' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows an ACTIVE thread next to an ARCHIVED one for the same repo and feature (US-002 AC9)', async () => {
    await thread({ feature: 'after-archive', status: 'ARCHIVED', archivedAt: new Date() });
    await expect(thread({ feature: 'after-archive' })).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('rejects a second message with the same thread and seq (US-002 AC10)', async () => {
    const t = await thread({ feature: 'seq-dup' });
    await prisma.chatMessage.create({ data: { threadId: t.id, seq: 1, role: 'user', content: 'a', status: 'complete' } });
    await expect(prisma.chatMessage.create({ data: { threadId: t.id, seq: 1, role: 'user', content: 'b', status: 'complete' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a second message with the same thread and clientMessageId (US-002 AC11)', async () => {
    const t = await thread({ feature: 'client-dup' });
    await prisma.chatMessage.create({ data: { threadId: t.id, seq: 1, role: 'user', content: 'a', status: 'complete', clientMessageId: 'cm-1' } });
    await expect(prisma.chatMessage.create({ data: { threadId: t.id, seq: 2, role: 'user', content: 'b', status: 'complete', clientMessageId: 'cm-1' } }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows several messages with a null clientMessageId in one thread (US-002 AC12)', async () => {
    const t = await thread({ feature: 'client-null' });
    await prisma.chatMessage.create({ data: { threadId: t.id, seq: 1, role: 'user', content: 'a', status: 'complete' } });
    await expect(prisma.chatMessage.create({ data: { threadId: t.id, seq: 2, role: 'user', content: 'b', status: 'complete' } }))
      .resolves.toBeDefined();
  });

  it('cascades a FleetThreadTurn when its FleetJob is deleted (US-002 AC13)', async () => {
    const t = await thread({ feature: 'turn-cascade' });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: base.projectId, repoId: base.repoId, ref: 'main', command: 'THREAD', feature: 'turn-cascade', profiles: [],
        selectorLabels: [], maxCostUsd: new Prisma.Decimal(1), requestedById: base.adminId, threadId: t.id,
      },
    });
    const turn = await prisma.fleetThreadTurn.create({
      data: {
        jobId: job.id, threadId: t.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native' }, skills: [], resume: false,
      },
    });
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'CANCELLED' } });
    await prisma.fleetJob.delete({ where: { id: job.id } });
    expect(await prisma.fleetThreadTurn.findUnique({ where: { jobId: turn.jobId } })).toBeNull();
  });

  describe('the migration itself', () => {
    let scratch: ScratchSchema;
    beforeAll(async () => {
      scratch = await scratchSchemaBefore(process.env.DATABASE_URL as string, 'chat_threads_mig', MIGRATION);
      // A pre-existing runner row, written by the schema that precedes the migration.
      await scratch.db.$executeRawUnsafe(
        `INSERT INTO "Runner" ("id", "name", "apiKeyHash", "os", "arch", "labels", "capabilities", "daemonVersion", "protocolVersion", "bootId", "lastSeenAt", "createdById", "updatedAt")
         VALUES ('r-pre', 'pre-thread-runner', 'hash-pre', 'linux', 'x64', ARRAY['linux'], '{}', '0.1.0', 1, 'boot-1', CURRENT_TIMESTAMP, 'u-pre', CURRENT_TIMESTAMP)`,
      );
      await applyMigration(scratch.db, MIGRATION);
    });
    afterAll(async () => {
      await scratch.drop();
    });

    it('backfills an existing runner with threadCapacity 2 (US-002 AC14)', async () => {
      const row = await scratch.db.$queryRawUnsafe<Array<{ threadCapacity: number }>>(
        `SELECT "threadCapacity" FROM "Runner" WHERE "id" = 'r-pre'`,
      );
      expect(row).toEqual([{ threadCapacity: 2 }]);
    });
  });
});
