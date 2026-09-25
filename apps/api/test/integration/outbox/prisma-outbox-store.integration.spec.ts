/**
 * PrismaOutboxStore on real Postgres (Track 1 slice 2).
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- prisma-outbox-store
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { OutboxService as NathappOutboxService, OutboxStatus } from '@nathapp/nestjs-outbox';
import { PrismaOutboxStore } from '../../../src/outbox/prisma-outbox.store';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('PrismaOutboxStore', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let store: PrismaOutboxStore;
  let outbox: NathappOutboxService;
  let projectId: string;

  const t0 = new Date('2026-09-26T10:00:00.000Z');
  const at = (ms: number): Date => new Date(t0.getTime() + ms);

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
      providers: [PrismaOutboxStore],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get(TRANSACTION_MANAGER);
    store = module.get(PrismaOutboxStore);
    outbox = new NathappOutboxService(store, txManager);
    const project = await prisma.client.project.create({ data: { name: 'Outbox', slug: 'outbox-store', key: 'OBX' } });
    projectId = project.id;
  });

  beforeEach(async () => {
    await prisma.client.outboxEvent.deleteMany({});
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  /** Inserts a pending row directly, due at `due`. */
  const seed = async (id: string, due: Date, overrides: Record<string, unknown> = {}): Promise<void> => {
    await prisma.client.outboxEvent.create({
      data: { id, projectId, type: 'ticket_event', eventId: id, payload: '{"n":1}', nextAttemptAt: due, createdAt: due, ...overrides },
    });
  };

  describe('save (via the package OutboxService.record)', () => {
    it('writes projectId and eventId columns from metadata, payload as JSON text', async () => {
      await txManager.run(() =>
        outbox.record({ type: 'ticket_event', payload: { a: 1 }, metadata: { projectId, eventId: 'evt-1' } }),
      );
      const rows = await prisma.client.outboxEvent.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ projectId, eventId: 'evt-1', type: 'ticket_event', payload: '{"a":1}', status: 'pending', attempts: 0 });
    });

    it('a rolled-back transaction leaves no outbox row', async () => {
      await expect(
        txManager.run(async () => {
          await outbox.record({ type: 'ticket_event', payload: {}, metadata: { projectId, eventId: 'evt-rb' } });
          throw new Error('business write failed');
        }),
      ).rejects.toThrow('business write failed');
      expect(await prisma.client.outboxEvent.count()).toBe(0);
    });

    it('rejects a record without metadata.projectId', async () => {
      await expect(outbox.record({ type: 'ticket_event', payload: {} })).rejects.toBeInstanceOf(ValidationAppException);
      expect(await prisma.client.outboxEvent.count()).toBe(0);
    });

    it('falls back to the record id when metadata.eventId is absent', async () => {
      const record = await outbox.record({ type: 'ticket_event', payload: {}, metadata: { projectId } });
      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.eventId).toBe(record.id);
    });

    it('stores headers as JSON text', async () => {
      const record = await outbox.record({ type: 't', payload: {}, headers: { trace: 'abc' }, metadata: { projectId } });
      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
      expect(row.headers).toBe('{"trace":"abc"}');
    });
  });

  describe('claimBatch', () => {
    it('claims due pending rows oldest-due first, up to the limit, and leases them', async () => {
      await seed('b', at(-2000));
      await seed('a', at(-3000));
      await seed('c', at(-1000));
      await seed('future', at(60_000));

      const claimed = await store.claimBatch(2, 30_000, t0, 'owner-1');

      expect(claimed.map((r) => r.id)).toEqual(['a', 'b']);
      expect(claimed[0]).toMatchObject({ status: OutboxStatus.PROCESSING, owner: 'owner-1', payload: { n: 1 } });
      expect(claimed[0].leaseUntil).toEqual(at(30_000));
      expect(claimed[0].metadata).toEqual({ projectId, eventId: 'a' });
    });

    it('never returns the same row to two concurrent claimers', async () => {
      for (let i = 0; i < 10; i += 1) await seed(`r${i}`, at(-1000 - i));

      const [one, two] = await Promise.all([
        store.claimBatch(10, 30_000, t0, 'owner-a'),
        store.claimBatch(10, 30_000, t0, 'owner-b'),
      ]);

      const ids = [...one, ...two].map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(10);
    });

    it('does not reclaim a row whose lease is still live', async () => {
      await seed('leased', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      expect(await store.claimBatch(10, 30_000, at(10_000), 'owner-b')).toHaveLength(0);
    });

    it('reclaims a row whose lease expired', async () => {
      await seed('expired', at(-1000));
      await store.claimBatch(10, 1_000, t0, 'owner-a');

      const reclaimed = await store.claimBatch(10, 30_000, at(5_000), 'owner-b');

      expect(reclaimed.map((r) => r.id)).toEqual(['expired']);
      expect(reclaimed[0].owner).toBe('owner-b');
    });

    it('never claims published or dead rows', async () => {
      await seed('pub', at(-1000), { status: 'published' });
      await seed('dead', at(-1000), { status: 'dead' });

      expect(await store.claimBatch(10, 30_000, t0, 'owner-a')).toHaveLength(0);
    });

    it('hands over a row with unparseable payload as the raw string instead of throwing', async () => {
      await seed('bad-json', at(-1000), { payload: 'not-json{' });

      const claimed = await store.claimBatch(10, 30_000, t0, 'owner-a');

      expect(claimed).toHaveLength(1);
      expect(claimed[0].payload).toBe('not-json{');
    });
  });

  describe('state transitions are owner-checked', () => {
    it('markPublished by a stale owner is a no-op, by the current owner publishes', async () => {
      await seed('race', at(-1000));
      await store.claimBatch(10, 1_000, t0, 'stale');
      await store.claimBatch(10, 30_000, at(5_000), 'current');

      await store.markPublished('race', at(6_000), 'stale');
      let row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'race' } });
      expect(row).toMatchObject({ status: 'processing', owner: 'current' });

      await store.markPublished('race', at(7_000), 'current');
      row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'race' } });
      expect(row).toMatchObject({ status: 'published', owner: null, leaseUntil: null, publishedAt: at(7_000) });
    });

    it('markRetry requeues with backoff, keeps lastError, and the row is not claimable before nextAttemptAt', async () => {
      await seed('retry', at(-1000), { lastError: 'handler failed' });
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      await store.markRetry('retry', 1, at(4_000), 'owner-a');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'retry' } });
      expect(row).toMatchObject({ status: 'pending', attempts: 1, owner: null, leaseUntil: null, lastError: 'handler failed', nextAttemptAt: at(4_000) });
      expect(await store.claimBatch(10, 30_000, at(3_999), 'owner-b')).toHaveLength(0);
      expect(await store.claimBatch(10, 30_000, at(4_000), 'owner-b')).toHaveLength(1);
    });

    it('markDead moves the row to dead with the final attempt count', async () => {
      await seed('doomed', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'owner-a');

      await store.markDead('doomed', 8, 'owner-a');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'doomed' } });
      expect(row).toMatchObject({ status: 'dead', attempts: 8, owner: null, leaseUntil: null });
    });

    it('markRetry and markDead by a stale owner are no-ops', async () => {
      await seed('guarded', at(-1000));
      await store.claimBatch(10, 30_000, t0, 'current');

      await store.markRetry('guarded', 1, at(4_000), 'someone-else');
      await store.markDead('guarded', 8, 'someone-else');

      const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: 'guarded' } });
      expect(row).toMatchObject({ status: 'processing', owner: 'current', attempts: 0 });
    });
  });
});
