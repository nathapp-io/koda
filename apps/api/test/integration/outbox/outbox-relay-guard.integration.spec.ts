import type { NathApplication } from '@nathapp/nestjs-app';
import { OutboxRelay } from '@nathapp/nestjs-outbox';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { FanOutPublisher, type OutboxHandlerFn } from '../../../src/outbox/fan-out-publisher';
import { bootHttpApp } from '../../helpers/http-app';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const TIMEOUT = 60_000;

describeIntegration('outbox relay writes under the context guard (US-003)', () => {
  let app: NathApplication;
  let fixtureDb: PrismaClient;
  let publisher: FanOutPublisher;
  let relay: OutboxRelay;
  const registered: Array<{ type: string; handler: OutboxHandlerFn }> = [];

  beforeAll(async () => {
    await resetDb();
    fixtureDb = createTestPrismaClient();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    publisher = app.get(FanOutPublisher);
    relay = app.get(OutboxRelay);
  }, TIMEOUT);

  afterEach(() => {
    for (const { type, handler } of registered.splice(0)) publisher.unregister(type, handler);
  });

  afterAll(async () => {
    for (const { type, handler } of registered.splice(0)) publisher?.unregister(type, handler);
    await app?.close();
    await fixtureDb?.$disconnect();
  }, TIMEOUT);

  async function pendingRow(): Promise<string> {
    const id = `guard-probe-${crypto.randomUUID()}`;
    await fixtureDb.outboxEvent.create({ data: { id, type: 'guard_probe', eventId: id, payload: '{}', status: 'pending', nextAttemptAt: new Date(0) } });
    return id;
  }

  function register(handler: OutboxHandlerFn): void {
    publisher.register('guard_probe', handler);
    registered.push({ type: 'guard_probe', handler });
  }

  it('AC-6: dispatches a resolved handler and marks its row published', async () => {
    register(async () => undefined);
    const id = await pendingRow();

    await relay.dispatchPendingBatch();

    const row = await fixtureDb.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('published');
  }, TIMEOUT);

  it('AC-7/8: records handler failure and returns the event to pending for retry', async () => {
    register(() => { throw new Error('boom'); });
    const id = await pendingRow();

    await relay.dispatchPendingBatch();

    const row = await fixtureDb.outboxEvent.findUniqueOrThrow({ where: { id } });
    expect(row.lastError).toContain('boom');
    expect(row.status).toBe('pending');
  }, TIMEOUT);
});
