/**
 * Outbox retention purge on real Postgres (issue #135).
 * Run: cd apps/api && bun run test:integration -- outbox-retention
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaOutboxRepository } from '../../../src/outbox/prisma-outbox.repository';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('PrismaOutboxRepository.deleteTerminalBefore', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaOutboxRepository;
  let projectId: string;

  const t0 = new Date('2026-09-26T04:00:00.000Z');
  const daysAgo = (days: number, offsetMs = 0): Date => new Date(t0.getTime() - days * 86_400_000 + offsetMs);
  const afterCutoff = (ms: number): Date => new Date(t0.getTime() + ms);

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [PrismaOutboxRepository],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    repo = module.get(PrismaOutboxRepository);
    const project = await prisma.client.project.create({ data: { name: 'Outbox Retention', slug: 'outbox-retention', key: 'OBR' } });
    projectId = project.id;
  });

  beforeEach(async () => {
    await prisma.client.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  /** Inserts a row directly with an explicit terminal status and updatedAt. */
  const seed = async (id: string, status: string, updatedAt: Date): Promise<void> => {
    await prisma.client.outboxEvent.create({
      data: {
        id,
        projectId,
        type: 'ticket_event',
        eventId: `ev-${id}`,
        status,
        attempts: status === 'dead' ? 8 : 0,
        publishedAt: status === 'published' ? updatedAt : null,
        updatedAt,
      },
    });
  };

  const remainingIds = async (): Promise<string[]> =>
    (await prisma.client.outboxEvent.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).map((r) => r.id);

  it('deletes old terminal rows only: recent terminal, old pending, and rows exactly at the cutoff survive', async () => {
    await seed('published-old', 'published', daysAgo(40));
    await seed('published-edge', 'published', t0); // cutoff is exclusive
    await seed('published-new', 'published', afterCutoff(3_600_000));
    await seed('dead-old', 'dead', daysAgo(40, 60_000));
    await seed('dead-new', 'dead', afterCutoff(7_200_000));
    await seed('pending-old', 'pending', daysAgo(40));
    await seed('processing-old', 'processing', daysAgo(40));

    const deleted = await repo.deleteTerminalBefore(['published', 'dead'], t0);

    expect(deleted).toBe(2);
    expect(await remainingIds()).toEqual([
      'dead-new',
      'pending-old',
      'processing-old',
      'published-edge',
      'published-new',
    ]);
  });

  it('returns 0 when nothing is old enough', async () => {
    await seed('published-new', 'published', afterCutoff(3_600_000));
    await seed('dead-new', 'dead', afterCutoff(3_600_000));

    const deleted = await repo.deleteTerminalBefore(['published', 'dead'], daysAgo(30));

    expect(deleted).toBe(0);
  });

  it('is served by the retention index from the schema (migration parity guard)', async () => {
    const indexes = await prisma.client.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'OutboxEvent' AND indexname = 'OutboxEvent_status_updatedAt_idx'`,
    );
    expect(indexes).toHaveLength(1);
  });
});
