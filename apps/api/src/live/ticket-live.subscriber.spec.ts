import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors, outboxRecord } from '../../test/helpers/outbox-record';
import { ProjectEventBus } from './project-event-bus';
import { TicketLiveSubscriber } from './ticket-live.subscriber';
import { toLiveEvent } from './live-event';

const envelope = (action: string, overrides: Record<string, unknown> = {}) => ({
  id: 'evt-1',
  type: 'ticket_event',
  action,
  timestamp: '2026-09-26T01:02:03.000Z',
  ticketId: 't1',
  projectId: 'p1',
  actorId: 'u1',
  actorType: 'user',
  data: { title: 'secret title' },
  ...overrides,
});

describe('toLiveEvent', () => {
  it.each([
    ['TICKET_CREATED', 'created'],
    ['TICKET_UPDATED', 'updated'],
    ['status_changed', 'transitioned'],
    ['assigned', 'assigned'],
    ['COMMENT_ADDED', 'commented'],
    ['TICKET_DELETED', 'deleted'],
  ])('maps %s to %s', (action, live) => {
    expect(toLiveEvent(envelope(action))).toEqual({
      id: 'evt-1',
      type: 'ticket',
      action: live,
      projectId: 'p1',
      ticketId: 't1',
      actorId: 'u1',
      at: '2026-09-26T01:02:03.000Z',
    });
  });

  it('carries no ticket content', () => {
    expect(JSON.stringify(toLiveEvent(envelope('TICKET_CREATED')))).not.toContain('secret title');
  });

  it.each([
    ['an unknown action', envelope('label_added')],
    ['a prototype-chain action key (toString)', envelope('TICKET_CREATED', { action: 'toString' })],
    ['a prototype-chain action key (constructor)', envelope('TICKET_CREATED', { action: 'constructor' })],
    ['a missing ticketId', envelope('TICKET_CREATED', { ticketId: undefined })],
    ['a missing projectId', envelope('TICKET_CREATED', { projectId: undefined })],
    ['a missing id', envelope('TICKET_CREATED', { id: undefined })],
    ['a non-object payload', 'not-an-object'],
    ['null', null],
  ])('returns null for %s', (_label, payload) => {
    expect(toLiveEvent(payload)).toBeNull();
  });
});

describe('TicketLiveSubscriber', () => {
  it('registers on ticket_event and publishes mapped events to the bus', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = new ProjectEventBus();
    const listener = vi.fn();
    bus.subscribe('p1', listener);
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await registry.publish(outboxRecord('ticket_event', envelope('status_changed')));

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1', action: 'transitioned' }));
  });

  it('drops unknown actions silently', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = new ProjectEventBus();
    const listener = vi.fn();
    bus.subscribe('p1', listener);
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await registry.publish(outboxRecord('ticket_event', envelope('label_added')));

    expect(listener).not.toHaveBeenCalled();
  });

  it('never throws, so it can never cause an outbox retry', async () => {
    const registry = new FanOutPublisher(noopLastErrors);
    const bus = { publish: vi.fn(() => { throw new Error('bus down'); }) } as unknown as ProjectEventBus;
    new TicketLiveSubscriber(registry, bus).onModuleInit();

    await expect(registry.publish(outboxRecord('ticket_event', envelope('TICKET_CREATED')))).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });
});
