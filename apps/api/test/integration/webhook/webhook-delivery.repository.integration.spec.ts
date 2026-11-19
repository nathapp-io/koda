import { canRunDbTests } from '../../helpers/test-environment';
/**
 * US-002 — the WebhookDelivery retention delete. The replay guard's dedup rows are deleted after the
 * configured horizon, so the delete has to be a strict `receivedAt < cutoff` and report its count.
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/webhook/webhook-delivery.repository.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaWebhookDeliveryRepository } from '../../../src/webhook-security/prisma-webhook-delivery.repository';
import { bootHttpApp } from '../../helpers/http-app';
import { withTestActor } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';

// The nax sandbox withholds host Postgres/Docker.
const describeDb = canRunDbTests() ? describe : describe.skip;

const DAY = 86_400_000;
const CUTOFF = new Date('2026-05-01T00:00:00.000Z');

describeDb('WebhookDelivery repository retention (PG)', () => {
  const prisma = createTestPrismaClient();
  let app: NathApplication;
  let repo: PrismaWebhookDeliveryRepository;
  let projectId: string;
  let n = 0;

  const received = (receivedAt: Date) =>
    prisma.webhookDelivery.create({
      data: { projectId, source: 'github', deliveryId: `delivery-${++n}`, receivedAt },
    });
  const find = (id: string) => prisma.webhookDelivery.findUnique({ where: { id } });
  /**
   * The purge's own actor: the processor runs as `SYSTEM/webhook-delivery` (its key's second segment),
   * and the app's Prisma client refuses a write outside an action context.
   */
  const purge = (before: Date) =>
    withTestActor({ type: 'SYSTEM', id: 'webhook-delivery' }, () => repo.deleteReceivedBefore(before));

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    repo = new PrismaWebhookDeliveryRepository(app.get(TRANSACTION_MANAGER), app.get(PrismaService));
    const project = await prisma.project.create({ data: { name: 'Hooks', slug: 'hooks-retention', key: 'HKR' } });
    projectId = project.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.webhookDelivery.deleteMany();
  });

  it('AC-1: deletes a delivery received before the cutoff', async () => {
    const stale = await received(new Date(CUTOFF.getTime() - DAY));

    const deleted = await purge(CUTOFF);

    expect(deleted).toBe(1);
    expect(await find(stale.id)).toBeNull();
  });

  it('AC-2: keeps a delivery received after the cutoff in that same run', async () => {
    const stale = await received(new Date(CUTOFF.getTime() - DAY));
    const fresh = await received(new Date(CUTOFF.getTime() + DAY));

    const deleted = await purge(CUTOFF);

    expect(deleted).toBe(1);
    expect(await find(stale.id)).toBeNull();
    expect(await find(fresh.id)).not.toBeNull();
  });

  /**
   * F1: the repository is built on the transaction manager, so its delete runs on the caller's
   * transaction client — a caller that rolls back keeps the rows (the retention purge depends on this:
   * a rejected audit record must not lose the deliveries).
   */
  it('F1: rolls the delete back with the enclosing transaction', async () => {
    const stale = await received(new Date(CUTOFF.getTime() - DAY));
    const txManager = app.get<ITransactionManager>(TRANSACTION_MANAGER);

    await expect(
      withTestActor({ type: 'SYSTEM', id: 'webhook-delivery' }, () =>
        txManager.run(async () => {
          const deleted = await repo.deleteReceivedBefore(CUTOFF);
          if (deleted !== 1) throw new Error(`expected 1 deleted row, got ${deleted}`);
          throw new Error('rollback');
        }),
      ),
    ).rejects.toThrow('rollback');

    expect(await find(stale.id)).not.toBeNull();
  });
});
