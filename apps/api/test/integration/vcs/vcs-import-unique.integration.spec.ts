import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Review P2 remainder (US-003): a VCS issue imports into at most one ticket per project.
 *
 * The uniqueness lives in Postgres (`Ticket_projectId_externalVcsId_key`), so the import race is
 * decided by the insert, not by the pre-check: outside a transaction the loser answers null (the
 * caller reports `skipped`), inside an enclosing transaction the violation propagates and that
 * transaction fails as a whole.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/vcs-import-unique.integration.spec.ts
 */
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService, PrismaTransactionManager } from '@nathapp/nestjs-prisma';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { VcsSyncService, type SyncIssueResult } from '../../../src/vcs/vcs-sync.service';
import type { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import type { VcsIssue } from '../../../src/vcs/types';
import { isUniqueViolation } from '../../../src/common/utils/prisma-errors';
import { resetDb } from '../../helpers/reset-db';
import { applyMigration, scratchSchemaBefore, type ScratchSchema } from '../../helpers/migration-schema';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const DATABASE_URL = process.env.DATABASE_URL;
// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const MIGRATION = '20261120090000_ticket_external_vcs_unique';
const DUPLICATED_EXTERNAL_ID = 'acme/widgets#5';

describeIntegration('Ticket (projectId, externalVcsId) uniqueness (US-003)', () => {
  vi.setConfig({ testTimeout: 30000 });
  let prismaService: PrismaService<PrismaClient>;
  let db: PrismaClient;
  let tx: PrismaTransactionManager;
  let repo: PrismaVcsRepository;
  let sync: VcsSyncService;
  const auditRecord = vi.fn(async () => undefined);

  const issue = (number: number): VcsIssue => ({
    number,
    title: `Issue ${number}`,
    body: null,
    authorLogin: 'octo',
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    createdAt: new Date(),
  });

  const repoRef = { repoOwner: 'acme', repoName: 'widgets' };

  const createProject = async (slug: string, key: string): Promise<string> =>
    (await db.project.create({ data: { name: slug, slug, key } })).id;

  const ticketCount = async (projectId: string, externalVcsId: string): Promise<number> =>
    db.ticket.count({ where: { projectId, externalVcsId } });

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { adapter: createPgAdapter(DATABASE_URL) },
    });
    await prismaService.onModuleInit();
    db = prismaService.client;
    // The real transaction manager: `prisma.client` routes to the active transaction, so a call made
    // inside `tx.run` really runs inside that transaction and its violation really aborts it.
    tx = new PrismaTransactionManager(db);
    const transactionalPrisma = {
      get client() {
        return tx.getClient<PrismaClient>() ?? db;
      },
    } as unknown as PrismaService<PrismaClient>;
    repo = new PrismaVcsRepository(tx, transactionalPrisma);
    sync = new VcsSyncService(repo, { record: auditRecord } as unknown as AuditRecorder);
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  describe('the shipped constraint', () => {
    it('AC-1: rejects a second ticket with the same projectId and externalVcsId with P2002', async () => {
      const projectId = await createProject('unique-ac1', 'AC1');
      await db.ticket.create({
        data: { projectId, number: 1, type: 'TASK', title: 'First', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });

      const error = await db.ticket
        .create({
          data: { projectId, number: 2, type: 'TASK', title: 'Second', externalVcsId: DUPLICATED_EXTERNAL_ID },
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      expect(isUniqueViolation(error, 'externalVcsId')).toBe(true);
      // The index does not cover `number`, so the ticket-number retry never treats this as its own conflict.
      expect(isUniqueViolation(error, 'number')).toBe(false);
      await expect(ticketCount(projectId, DUPLICATED_EXTERNAL_ID)).resolves.toBe(1);
    });

    it('AC-2: stores the same externalVcsId in two different projects', async () => {
      const first = await createProject('unique-ac2-a', 'AC2A');
      const second = await createProject('unique-ac2-b', 'AC2B');

      await db.ticket.create({
        data: { projectId: first, number: 1, type: 'TASK', title: 'One', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });
      await db.ticket.create({
        data: { projectId: second, number: 1, type: 'TASK', title: 'Two', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });

      await expect(ticketCount(first, DUPLICATED_EXTERNAL_ID)).resolves.toBe(1);
      await expect(ticketCount(second, DUPLICATED_EXTERNAL_ID)).resolves.toBe(1);
    });

    it('AC-3: stores two tickets with a null externalVcsId in one project', async () => {
      const projectId = await createProject('unique-ac3', 'AC3');

      await db.ticket.create({ data: { projectId, number: 1, type: 'TASK', title: 'Hand made' } });
      await db.ticket.create({ data: { projectId, number: 2, type: 'TASK', title: 'Hand made too' } });

      await expect(db.ticket.count({ where: { projectId } })).resolves.toBe(2);
    });
  });

  describe('createTicketFromIssue', () => {
    it('AC-4: answers null outside a transaction for an externalVcsId the project already holds', async () => {
      const projectId = await createProject('unique-ac4', 'AC4');
      await db.ticket.create({
        data: { projectId, number: 1, type: 'TASK', title: 'Imported', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });

      await expect(
        repo.createTicketFromIssue({ id: projectId }, issue(5), DUPLICATED_EXTERNAL_ID),
      ).resolves.toBeNull();
    });

    it('AC-5: creates no additional ticket in that case', async () => {
      const projectId = await createProject('unique-ac5', 'AC5');
      await db.ticket.create({
        data: { projectId, number: 1, type: 'TASK', title: 'Imported', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });
      const onCreated = vi.fn(async () => undefined);

      await repo.createTicketFromIssue({ id: projectId }, issue(5), DUPLICATED_EXTERNAL_ID, onCreated);

      await expect(db.ticket.count({ where: { projectId } })).resolves.toBe(1);
      expect(onCreated).not.toHaveBeenCalled();
    });

    it('AC-6: rethrows P2002 for the same case inside an enclosing transaction', async () => {
      const projectId = await createProject('unique-ac6', 'AC6');
      await db.ticket.create({
        data: { projectId, number: 1, type: 'TASK', title: 'Imported', externalVcsId: DUPLICATED_EXTERNAL_ID },
      });

      const error = await tx
        .run(async () => repo.createTicketFromIssue({ id: projectId }, issue(5), DUPLICATED_EXTERNAL_ID))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      expect(isUniqueViolation(error, 'externalVcsId')).toBe(true);
      // The enclosing transaction failed as a whole: its insert was rolled back.
      await expect(db.ticket.count({ where: { projectId } })).resolves.toBe(1);
    });
  });

  describe('two concurrent imports of the same issue (outside any transaction)', () => {
    it('AC-8: produce exactly one ticket', async () => {
      const projectId = await createProject('unique-ac8', 'AC8');
      const target = issue(7);

      await Promise.all([
        sync.syncIssue({ id: projectId }, target, 'webhook', repoRef, 'system.vcs.webhook-intake'),
        sync.syncIssue({ id: projectId }, target, 'webhook', repoRef, 'system.vcs.webhook-intake'),
      ]);

      await expect(db.ticket.count({ where: { projectId } })).resolves.toBe(1);
      await expect(ticketCount(projectId, 'acme/widgets#7')).resolves.toBe(1);
    });

    it('AC-9: answer one skipped and one created', async () => {
      const projectId = await createProject('unique-ac9', 'AC9');
      const target = issue(8);

      const results: SyncIssueResult[] = await Promise.all([
        sync.syncIssue({ id: projectId }, target, 'webhook', repoRef, 'system.vcs.webhook-intake'),
        sync.syncIssue({ id: projectId }, target, 'webhook', repoRef, 'system.vcs.webhook-intake'),
      ]);

      expect(results.map((result) => result.action).sort()).toEqual(['created', 'skipped']);
      expect(results.find((result) => result.action === 'skipped')).toEqual({
        action: 'skipped',
        reason: 'Ticket with this external VCS ID already exists',
      });
    });
  });
});

describeIntegration('Ticket_projectId_externalVcsId_key migration (US-003)', () => {
  vi.setConfig({ testTimeout: 120000 });
  let scratch: ScratchSchema;

  beforeAll(async () => {
    scratch = await scratchSchemaBefore(DATABASE_URL as string, 'vcs_import_unique', MIGRATION);
    const { db } = scratch;
    await db.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "name", "slug", "key", "updatedAt") VALUES
        ('p1', 'First', 'first', 'FST', CURRENT_TIMESTAMP),
        ('p2', 'Second', 'second', 'SND', CURRENT_TIMESTAMP)
    `);
    await db.$executeRawUnsafe(`
      INSERT INTO "Ticket" ("id", "projectId", "number", "type", "title", "externalVcsId", "updatedAt") VALUES
        ('t-keep',     'p1', 1, 'TASK', 'lowest number wins',       '${DUPLICATED_EXTERNAL_ID}', CURRENT_TIMESTAMP),
        ('t-dup-2',    'p1', 2, 'TASK', 'duplicate of number 1',    '${DUPLICATED_EXTERNAL_ID}', CURRENT_TIMESTAMP),
        ('t-dup-3',    'p1', 3, 'TASK', 'another duplicate',        '${DUPLICATED_EXTERNAL_ID}', CURRENT_TIMESTAMP),
        ('t-other',    'p1', 4, 'TASK', 'another issue',            'acme/widgets#9',            CURRENT_TIMESTAMP),
        ('t-null-a',   'p1', 5, 'TASK', 'hand made',                NULL,                        CURRENT_TIMESTAMP),
        ('t-null-b',   'p1', 6, 'TASK', 'hand made too',            NULL,                        CURRENT_TIMESTAMP),
        ('t-other-prj','p2', 1, 'TASK', 'same issue, other project','${DUPLICATED_EXTERNAL_ID}', CURRENT_TIMESTAMP)
    `);
    await applyMigration(db, MIGRATION);
  });

  afterAll(async () => {
    await scratch?.drop();
  });

  it('clears every duplicate except the lowest ticket number of the project', async () => {
    const rows = await scratch.db.$queryRawUnsafe<Array<{ id: string; externalVcsId: string | null }>>(
      `SELECT "id", "externalVcsId" FROM "Ticket" ORDER BY "projectId", "number"`,
    );

    expect(rows).toEqual([
      { id: 't-keep', externalVcsId: DUPLICATED_EXTERNAL_ID },
      { id: 't-dup-2', externalVcsId: null },
      { id: 't-dup-3', externalVcsId: null },
      { id: 't-other', externalVcsId: 'acme/widgets#9' },
      { id: 't-null-a', externalVcsId: null },
      { id: 't-null-b', externalVcsId: null },
      { id: 't-other-prj', externalVcsId: DUPLICATED_EXTERNAL_ID },
    ]);
  });

  it('creates the unique index the import relies on', async () => {
    const error = await scratch.db.ticket
      .create({
        data: {
          projectId: 'p1',
          number: 7,
          type: 'TASK',
          title: 'late duplicate',
          externalVcsId: DUPLICATED_EXTERNAL_ID,
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(isUniqueViolation(error, 'externalVcsId')).toBe(true);
  });
});
