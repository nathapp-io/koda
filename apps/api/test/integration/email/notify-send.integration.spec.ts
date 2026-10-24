import { canRunDbTests } from '../../helpers/test-environment';
import type { MockInstance } from 'vitest';
/**
 * Fleet S4b A5: booted AppModule — the seeder wrote the templates; NotifyService.send renders from the DB and records a
 * DeliveryLog through the real Prisma repositories. The registered email channel's send is spied (no SMTP).
 * Run: cd apps/api && bun run test:scoped test/integration/email/notify-send.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import {
  DELIVERY_CHANNEL_REGISTRY, DeliveryChannelRegistry, DeliveryStatus, INotifyService, NOTIFY_SERVICE, NotificationChannel,
} from '@nathapp/nestjs-notify';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
vi.setConfig({ testTimeout: 30_000 });

describeIntegration('nestjs-notify send on PG (S4b A5)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let notify: INotifyService;
  let send: MockInstance;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    notify = app.get(NOTIFY_SERVICE);
    const channel = app.get<DeliveryChannelRegistry>(DELIVERY_CHANNEL_REGISTRY).get(NotificationChannel.EMAIL);
    if (!channel) throw new Error('email channel not registered');
    send = vi.spyOn(channel, 'send').mockResolvedValue({ providerMessageId: 'r1' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('seeded 6 templates for tenant default', async () => {
    expect(await prisma.notificationTemplate.count({ where: { tenantId: 'default', channel: 'email' } })).toBe(6);
  });

  it('renders from the DB template and logs SENT', async () => {
    // `EmailDispatcher.sendOne` is the entry that calls the channel in production, and it runs as the
    // email component, so the delivery log below is written under the same actor.
    await withTestActor({ type: 'SYSTEM', id: 'email' }, () => notify.send({
      tenantId: 'default', channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION', locale: 'en', recipient: 'b@x.io',
      data: { title: 'KODA-1 assigned to you', body: '', url: 'https://k.x/koda/tickets/KODA-1', prefsUrl: 'https://k.x/settings/notifications' },
    }));
    const [payload, content, subject] = send.mock.calls.at(-1) as [{ recipient: string }, string, string];
    expect(payload.recipient).toBe('b@x.io');
    expect(subject).toBe('[koda] KODA-1 assigned to you');
    expect(content).toContain('https://k.x/koda/tickets/KODA-1');
    const log = await prisma.deliveryLog.findFirst({ where: { recipient: 'b@x.io' } });
    expect(log).toMatchObject({ tenantId: 'default', channel: 'email', templateCode: 'NOTIFICATION', status: DeliveryStatus.SENT, providerMessageId: 'r1' });
  });

  it('skips silently when the package email preference is off', async () => {
    const before = send.mock.calls.length;
    await prisma.notificationPreference.create({ data: { id: 'p-off', userId: 'u-off', tenantId: 'default', channel: 'email', enabled: false } });
    await withTestActor({ type: 'SYSTEM', id: 'email' }, () => notify.send({
      tenantId: 'default', channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION', recipient: 'off@x.io', userId: 'u-off',
      data: { title: 't', body: '', url: 'u', prefsUrl: 'p' },
    }));
    expect(send.mock.calls.length).toBe(before);
  });
});
