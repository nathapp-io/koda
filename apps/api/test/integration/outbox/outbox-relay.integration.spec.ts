/**
 * record() -> OutboxRelay -> FanOutPublisher -> handler, on real Postgres.
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- outbox-relay
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxRelay, OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { outboxConfig } from '../../../src/config/outbox.config';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { OutboxModule } from '../../../src/outbox/outbox.module';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('outbox relay end to end', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let txManager: ITransactionManager;
  let outbox: NathappOutboxService;
  let relay: OutboxRelay;
  let publisher: FanOutPublisher;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }),
        PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { datasources: { db: { url: DATABASE_URL } } } }),
        OutboxModule,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    txManager = module.get(TRANSACTION_MANAGER);
    outbox = module.get(NathappOutboxService);
    relay = module.get(OutboxRelay);
    publisher = module.get(FanOutPublisher);
    projectId = (await prisma.client.project.create({ data: { name: 'Relay', slug: 'relay', key: 'RLY' } })).id;
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  it('delivers a committed record to its handler and marks it published', async () => {
    const handler = jest.fn();
    publisher.register('relay_ok', handler);

    const record = await txManager.run(() =>
      outbox.record({ type: 'relay_ok', payload: { hello: 'world' }, metadata: { projectId, eventId: 'ok-1' } }),
    );
    await relay.dispatchPendingBatch();

    expect(handler).toHaveBeenCalledWith({ hello: 'world' });
    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'published', owner: null, lastError: null });
    expect(row.publishedAt).not.toBeNull();
  });

  it('schedules a retry with backoff and records lastError when a handler fails', async () => {
    publisher.register('relay_fail', () => {
      throw new Error('downstream unavailable');
    });

    const before = Date.now();
    const record = await outbox.record({ type: 'relay_fail', payload: {}, metadata: { projectId, eventId: 'fail-1' } });
    await relay.dispatchPendingBatch();

    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'pending', attempts: 1, owner: null });
    expect(row.lastError).toContain('downstream unavailable');
    // backoffBaseMs 2000 for the first retry
    expect(row.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 2000);

    // Not due yet: a second cycle leaves it alone.
    await relay.dispatchPendingBatch();
    const again = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(again.attempts).toBe(1);
  });

  it('moves the record to dead after maxAttempts', async () => {
    publisher.register('relay_dead', () => {
      throw new Error('always fails');
    });
    const record = await outbox.record({ type: 'relay_dead', payload: {}, metadata: { projectId, eventId: 'dead-1' } });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await prisma.client.outboxEvent.update({ where: { id: record.id }, data: { nextAttemptAt: new Date(0) } });
      await relay.dispatchPendingBatch();
    }

    const row = await prisma.client.outboxEvent.findUniqueOrThrow({ where: { id: record.id } });
    expect(row).toMatchObject({ status: 'dead', attempts: 8 });
  });
});
