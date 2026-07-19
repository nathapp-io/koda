import { WebhookOutboxSubscriber } from './webhook-outbox.subscriber';
import { WebhookDeliveryHandler } from './webhook-delivery.handler';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('WebhookOutboxSubscriber', () => {
  it('registers webhook_delivery and forwards payload to WebhookDeliveryHandler', async () => {
    const registry = new OutboxFanOutRegistry();
    const deliveryHandler = { handle: jest.fn().mockResolvedValue(undefined) } as unknown as WebhookDeliveryHandler;

    new WebhookOutboxSubscriber(registry, deliveryHandler).onModuleInit();
    expect(registry.getHandlers('webhook_delivery').length).toBe(1);

    const payload = { deliveryId: 'd1' };
    await registry.dispatch({ eventType: 'webhook_delivery', payload });
    expect(deliveryHandler.handle).toHaveBeenCalledWith(payload);
  });
});
