import { EntityGraphOutboxSubscriber } from './entity-graph-outbox.subscriber';
import { EntityGraphService } from './entity-graph.service';
import { OutboxFanOutRegistry } from '../outbox/outbox-fan-out-registry';

describe('EntityGraphOutboxSubscriber', () => {
  it('registers ticket_event and graphify_import and forwards to EntityGraphService', async () => {
    const registry = new OutboxFanOutRegistry();
    const svc = {
      onTicketEvent: jest.fn().mockResolvedValue(undefined),
      onGraphifyImport: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityGraphService;

    new EntityGraphOutboxSubscriber(registry, svc).onModuleInit();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('graphify_import').length).toBe(1);

    await registry.dispatch({
      eventType: 'graphify_import',
      payload: { projectId: 'p1', nodes: [{ nodeId: 'n1', type: 't', label: 'l' }], links: [] },
    });
    expect(svc.onGraphifyImport).toHaveBeenCalledWith('p1', [{ nodeId: 'n1', type: 't', label: 'l', tags: undefined, metadata: undefined }], []);
  });
});
