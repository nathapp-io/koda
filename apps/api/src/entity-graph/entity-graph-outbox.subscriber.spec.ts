import { EntityGraphOutboxSubscriber } from './entity-graph-outbox.subscriber';
import { EntityGraphService } from './entity-graph.service';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';

describe('EntityGraphOutboxSubscriber', () => {
  it('registers ticket_event and graphify_import and forwards to EntityGraphService', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const svc = {
      onTicketEvent: jest.fn().mockResolvedValue(undefined),
      onGraphifyImport: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityGraphService;

    new EntityGraphOutboxSubscriber(registry, svc).onModuleInit();

    expect(registry.getHandlers('ticket_event').length).toBe(1);
    expect(registry.getHandlers('graphify_import').length).toBe(1);

    await registry.publish(
      outboxRecord('graphify_import', { projectId: 'p1', nodes: [{ nodeId: 'n1', type: 't', label: 'l' }], links: [] }),
    );
    expect(svc.onGraphifyImport).toHaveBeenCalledWith('p1', [{ nodeId: 'n1', type: 't', label: 'l', tags: undefined, metadata: undefined }], []);
  });
});
