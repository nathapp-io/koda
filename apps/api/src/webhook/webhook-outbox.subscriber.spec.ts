import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';

describe('WebhookOutboxSubscriber', () => {
  it('registers webhook_delivery and forwards payload to WebhookDeliveryHandler', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const deliveryHandler = { handle: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookDeliveryHandler;

    new WebhookOutboxSubscriber(registry, deliveryHandler).onModuleInit();
    expect(registry.getHandlers('webhook_delivery').length).toBe(1);

    const payload = { deliveryId: 'd1' };
    await registry.publish(outboxRecord('webhook_delivery', payload));
    expect(deliveryHandler.handle).toHaveBeenCalledWith(payload);
  });
});
