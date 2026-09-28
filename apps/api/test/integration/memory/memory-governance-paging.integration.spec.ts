/**
 * M21: governance jobs must not skip rows while they move rows out of 'active',
 * and dedup must see duplicates that sit more than one page apart.
 * Run: cd apps/api && bun run test:scoped test/integration/memory/memory-governance-paging.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { MemoryGovernanceService } from '../../../src/memory/memory-governance.service';
import { MemoryKind } from '../../../src/common/enums';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('MemoryGovernanceService paging (M21)', () => {
  let prismaService: PrismaService<PrismaClient>;
  let service: MemoryGovernanceService;
  let projectId: string;
  let seq = 0;

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
    service = new MemoryGovernanceService(new PrismaMemoryItemRepository(txManager, prismaService));
  });

  afterAll(async () => {
    await prismaService?.onModuleDestroy();
  });

  beforeEach(async () => {
    seq += 1;
    projectId = (
      await prismaService.client.project.create({ data: { name: `M21 ${seq}`, slug: `m21-${seq}-${Date.now()}`, key: `MG${seq}` } })
    ).id;
  });

  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);

  it('expires every expired row even when there are several pages of them', async () => {
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `ticket:${i}`,
        predicate: 'status',
        activeKey: `FACT:ticket:${i}:status`,
        ttlAt: past,
      })),
    });

    const result = await service.expireMemories(projectId);

    expect(result.count).toBe(250);
    expect(await prismaService.client.memoryItem.count({ where: { projectId, status: 'active' } })).toBe(0);
  });

  it('deduplicates rows with the same key that sit more than a page apart', async () => {
    // A legacy active row without activeKey (the unique index allows one keyed row per key).
    const winner = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.FACT, subject: 'KODA-1', predicate: 'owner', confidence: 0.9, activeKey: null },
    });
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `filler:${i}`,
        predicate: 'status',
        activeKey: `FACT:filler:${i}:status`,
      })),
    });
    const loser = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.FACT, subject: 'KODA-1', predicate: 'owner', confidence: 0.5, activeKey: 'FACT:KODA-1:owner' },
    });

    const result = await service.deduplicate(projectId);

    expect(result.count).toBe(1);
    const after = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: loser.id } });
    expect(after).toMatchObject({ status: 'superseded', supersededBy: winner.id, activeKey: null });
  });

  it('supersedes older DECISIONs on the same topic across pages', async () => {
    const older = await prismaService.client.memoryItem.create({
      data: {
        projectId,
        kind: MemoryKind.DECISION,
        subject: 'agent:a1',
        predicate: 'db-choice',
        activeKey: 'DECISION:agent:a1:db-choice',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        projectId,
        kind: MemoryKind.DECISION,
        subject: `agent:filler${i}`,
        predicate: 'x',
        activeKey: `DECISION:agent:filler${i}:x`,
      })),
    });
    const newer = await prismaService.client.memoryItem.create({
      data: { projectId, kind: MemoryKind.DECISION, subject: 'agent:a1', predicate: 'db-choice', activeKey: null, createdAt: new Date('2026-06-01T00:00:00Z') },
    });

    const result = await service.applySupersession(projectId);

    expect(result.count).toBe(1);
    const after = await prismaService.client.memoryItem.findUniqueOrThrow({ where: { id: older.id } });
    expect(after).toMatchObject({ status: 'superseded', supersededBy: newer.id, activeKey: null });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await prismaService.client.memoryItem.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        projectId,
        kind: MemoryKind.FACT,
        subject: `ticket:${i}`,
        predicate: 'status',
        activeKey: `FACT:ticket:${i}:status`,
        ttlAt: past,
      })),
    });

    await service.runCleanup(projectId);
    const second = await service.runCleanup(projectId);

    expect(second).toMatchObject({ expiredCount: 0, deduplicatedCount: 0, supersessionCount: 0 });
  });
});
