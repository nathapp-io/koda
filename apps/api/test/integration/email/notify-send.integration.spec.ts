/**
 * Fleet S4b A5: booted AppModule — the seeder wrote the templates; NotifyService.send renders from the DB and records a
 * DeliveryLog through the real Prisma repositories. The registered email channel's send is spied (no SMTP).
 * Run: cd apps/api && bun run test:scoped test/integration/email/notify-send.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import {
  DELIVERY_CHANNEL_REGISTRY, DeliveryChannelRegistry, DeliveryStatus, INotifyService, NOTIFY_SERVICE, NotificationChannel,
} from '@nathapp/nestjs-notify';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
jest.setTimeout(30_000);

describeIntegration('nestjs-notify send on PG (S4b A5)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let notify: INotifyService;
  let send: jest.SpyInstance;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get(PrismaService).client as PrismaClient;
    notify = app.get(NOTIFY_SERVICE);
    const channel = app.get<DeliveryChannelRegistry>(DELIVERY_CHANNEL_REGISTRY).get(NotificationChannel.EMAIL);
    if (!channel) throw new Error('email channel not registered');
    send = jest.spyOn(channel, 'send').mockResolvedValue({ providerMessageId: 'r1' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('seeded 6 templates for tenant default', async () => {
    expect(await prisma.notificationTemplate.count({ where: { tenantId: 'default', channel: 'email' } })).toBe(6);
  });

  it('renders from the DB template and logs SENT', async () => {
    await notify.send({
      tenantId: 'default', channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION', locale: 'en', recipient: 'b@x.io',
      data: { title: 'KODA-1 assigned to you', body: '', url: 'https://k.x/koda/tickets/KODA-1', prefsUrl: 'https://k.x/settings/notifications' },
    });
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
    await notify.send({
      tenantId: 'default', channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION', recipient: 'off@x.io', userId: 'u-off',
      data: { title: 't', body: '', url: 'u', prefsUrl: 'p' },
    });
    expect(send.mock.calls.length).toBe(before);
  });
});
