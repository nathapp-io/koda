/**
 * Fleet S4b A1: nestjs-notify boots in koda with no tenant context. Real NotifyModule services, in-memory
 * repositories, a fake channel. Proves DI (TenantContextService, CLOCK, ID_GENERATOR) and that a send with
 * tenantId 'default' and no ALS tenant passes the mismatch check.
 */
import { Global, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DELIVERY_LOG_REPOSITORY, DeliveryStatus, IDeliveryChannel, INotifyService, NOTIFY_SERVICE, NotificationChannel, NotifyModule,
  PREFERENCE_REPOSITORY, SendNotificationPayload, TEMPLATE_REPOSITORY,
} from '@nathapp/nestjs-notify';
import { EmailPlatformModule } from './email-platform.module';
import { KODA_TENANT_ID } from './koda-tenant';

const sent: Array<{ to: string; subject?: string; content: string }> = [];

@Injectable()
class FakeEmailChannel implements IDeliveryChannel {
  readonly channel = NotificationChannel.EMAIL;
  async send(payload: SendNotificationPayload, content: string, subject?: string) {
    sent.push({ to: payload.recipient, subject, content });
    return { providerMessageId: 'm1' };
  }
}

const logs: Array<Record<string, unknown>> = [];

@Global()
@Module({
  providers: [
    {
      provide: TEMPLATE_REPOSITORY,
      useValue: {
        findTemplate: async () => ({
          id: 't', tenantId: KODA_TENANT_ID, code: 'NOTIFICATION', channel: 'email', locale: 'en',
          subject: 'Hi {{name}}', content: '<p>{{name}}</p>', isActive: true, metadata: {}, createdAt: new Date(), updatedAt: new Date(),
        }),
      },
    },
    { provide: PREFERENCE_REPOSITORY, useValue: { findByUserAndChannel: async () => null } },
    {
      provide: DELIVERY_LOG_REPOSITORY,
      useValue: {
        create: async (log: Record<string, unknown>) => { logs.push(log); return log; },
        updateStatus: async (id: string, _tenantId: string, status: string) => { logs.push({ id, status }); return {}; },
      },
    },
  ],
  exports: [TEMPLATE_REPOSITORY, PREFERENCE_REPOSITORY, DELIVERY_LOG_REPOSITORY],
})
class FakeRepositoriesModule {}

describe('nestjs-notify wiring (S4b A1)', () => {
  it('boots with EmailPlatformModule and sends with tenant "default" and no tenant context', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        EmailPlatformModule,
        FakeRepositoriesModule,
        NotifyModule.register({ deliveryChannels: [{ channel: NotificationChannel.EMAIL, provider: FakeEmailChannel }] }),
      ],
    }).compile();
    const notify = moduleRef.get<INotifyService>(NOTIFY_SERVICE);

    await notify.send({
      tenantId: KODA_TENANT_ID, channel: NotificationChannel.EMAIL, templateCode: 'NOTIFICATION',
      recipient: 'b@x.io', userId: 'u1', data: { name: '<Bea>' },
    });

    expect(sent).toEqual([{ to: 'b@x.io', subject: 'Hi <Bea>', content: '<p>&lt;Bea&gt;</p>' }]);
    expect(logs.map((l) => l.status)).toEqual([DeliveryStatus.QUEUED, DeliveryStatus.SENT]);
    await moduleRef.close();
  });
});
