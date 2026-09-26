/**
 * Outbox replays re-run MemoryOutboxSubscriber: an identical fact must be a no-op.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- memory-upsert-replay
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { MemoryKind } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaMemoryItemRepository.upsert replay', () => {
  let prismaService: PrismaService<PrismaClient>;
  let repo: PrismaMemoryItemRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    prismaService = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: process.env.DATABASE_URL } } } });
    await prismaService.onModuleInit();
    const prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaMemoryItemRepository(txManager, prismaService);
    projectId = (await prisma.project.create({ data: { name: 'Mem', slug: 'mem-replay', key: 'MEM' } })).id;
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  const fact = (object: string, sourceId = 'evt-1') => ({
    projectId,
    kind: Object.values(MemoryKind)[0] as MemoryKind,
    subject: 'KODA-1',
    predicate: 'assigned_to',
    object,
    sourceType: 'ticket_event',
    sourceId,
    confidence: 0.8,
    ttlAt: null,
  });

  it('a replay of the same fact from the same source keeps one row and the same id', async () => {
    const first = await repo.upsert(fact('alice'));
    const replay = await repo.upsert(fact('alice'));

    expect(replay.id).toBe(first.id);
    const rows = await prismaService.client.memoryItem.findMany({ where: { projectId, subject: 'KODA-1' } });
    expect(rows).toHaveLength(1);
  });

  it('a changed fact still supersedes the active one', async () => {
    const before = await repo.upsert(fact('alice'));
    const changed = await repo.upsert(fact('bob', 'evt-2'));

    expect(changed.id).not.toBe(before.id);
    const old = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: before.id } });
    expect(old.status).toBe('superseded');
  });
});
