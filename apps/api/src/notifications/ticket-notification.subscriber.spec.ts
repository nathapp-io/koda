import { Logger } from '@nestjs/common';
import { FanOutPublisher } from '../outbox/fan-out-publisher';
import { noopLastErrors } from '../../test/helpers/outbox-record';
import { TicketNotificationSubscriber } from './ticket-notification.subscriber';
import type { NotificationDraft } from './notification.types';

const envelope = (action: string, data: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  id: 'evt-1', type: 'ticket_event', action, timestamp: '2026-10-09T00:00:00.000Z', ticketId: 't1', projectId: 'p1',
  actorId: 'actor', actorType: 'user', data, ...over,
});

const TICKET = {
  id: 't1', projectId: 'p1', number: 12, title: 'Fix login', description: 'desc', createdByUserId: 'reporter', deletedAt: null,
  project: { key: 'KODA', slug: 'koda' },
};

function setup() {
  const registry = new FanOutPublisher(noopLastErrors);
  const reads = {
    findTicket: vi.fn().mockResolvedValue(TICKET),
    findComment: vi.fn().mockResolvedValue({ id: 'c1', ticketId: 't1', body: 'looks good', authorUserId: 'actor' }),
    actorName: vi.fn().mockResolvedValue('Alice'),
    isUser: vi.fn().mockResolvedValue(true),
  };
  const watchers = { ensure: vi.fn().mockResolvedValue(undefined), findUnmutedUserIds: vi.fn().mockResolvedValue(['reporter', 'actor', 'w1']) };
  const mentions = { mentionedUserIds: vi.fn().mockResolvedValue([]) };
  const writer = { deliver: vi.fn().mockResolvedValue(1) };
  const sub = new TicketNotificationSubscriber(registry, reads as never, watchers as never, mentions as never, writer as never);
  sub.onModuleInit();
  const delivered = (): NotificationDraft[] => writer.deliver.mock.calls.flatMap((c) => c[0] as NotificationDraft[]);
  return { registry, reads, watchers, mentions, writer, sub, delivered };
}

describe('TicketNotificationSubscriber (S4a §2.2)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('registers on ticket_event at init', () => {
    const { registry, sub } = setup();
    expect(registry.getHandlers('ticket_event')).toContain(sub.handle);
  });

  it('assigned to a user: watches as ASSIGNEE, then notifies the assignee', async () => {
    const { sub, watchers, delivered } = setup();
    await sub.handle(envelope('assigned', { assignedTo: 'bob', assigneeType: 'user' }));
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'bob', reason: 'ASSIGNEE' }]);
    expect(delivered()).toEqual([expect.objectContaining({
      userId: 'bob', kind: 'ticket_assigned', category: 'ASSIGNED', link: '/koda/tickets/KODA-12', sourceId: 'evt-1', actorId: 'actor',
      title: 'Alice assigned you KODA-12: Fix login',
    })]);
  });

  it('assigned to an agent, or unassigned: nothing', async () => {
    const { sub, writer, watchers } = setup();
    await sub.handle(envelope('assigned', { assignedTo: 'agent-1', assigneeType: 'agent' }));
    await sub.handle(envelope('assigned', { assignedTo: null, assigneeType: null }));
    expect(watchers.ensure).toHaveBeenCalledWith('t1', []);
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('a legacy assigned event without assigneeType asks whether the id is a user', async () => {
    const { sub, reads, delivered } = setup();
    reads.isUser.mockResolvedValueOnce(false);
    await sub.handle(envelope('assigned', { assignedTo: 'agent-1' }));
    expect(reads.isUser).toHaveBeenCalledWith('agent-1');
    expect(delivered()).toEqual([]);
  });

  it('a comment: watches the author, notifies unmuted watchers with the excerpt', async () => {
    const { sub, watchers, reads, delivered, mentions } = setup();
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'c1' }));
    expect(reads.findComment).toHaveBeenCalledWith('c1');
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith('p1', 'looks good');
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'actor', reason: 'COMMENTER' }]);
    expect(delivered().map((d) => [d.userId, d.kind, d.body])).toEqual([
      ['reporter', 'ticket_commented', 'looks good'],
      ['actor', 'ticket_commented', 'looks good'],
      ['w1', 'ticket_commented', 'looks good'],
    ]);
  });

  it('a status change notifies unmuted watchers', async () => {
    const { sub, delivered } = setup();
    await sub.handle(envelope('status_changed', { fromStatus: 'CREATED', newStatus: 'VERIFIED' }));
    expect(delivered().map((d) => d.title)).toEqual(Array(3).fill('KODA-12 moved CREATED → VERIFIED'));
  });

  it('creation watches the reporter and notifies nobody without mentions', async () => {
    const { sub, watchers, writer, mentions } = setup();
    await sub.handle(envelope('TICKET_CREATED', { type: 'BUG', title: 'Fix login' }));
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith('p1', 'desc');
    expect(watchers.ensure).toHaveBeenCalledWith('t1', [{ userId: 'reporter', reason: 'REPORTER' }]);
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('deleted ticket: no watcher, no notification, no throw (Review Focus 1)', async () => {
    const { sub, reads, watchers, writer } = setup();
    reads.findTicket.mockResolvedValueOnce({ ...TICKET, deletedAt: new Date() });
    await expect(sub.handle(envelope('COMMENT_ADDED', { commentId: 'c1' }))).resolves.toBeUndefined();
    reads.findTicket.mockResolvedValueOnce(null);
    await expect(sub.handle(envelope('status_changed', { fromStatus: 'A', newStatus: 'B' }))).resolves.toBeUndefined();
    expect(watchers.ensure).not.toHaveBeenCalled();
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('deleted comment or a comment of another ticket: nothing, no throw', async () => {
    const { sub, reads, writer } = setup();
    reads.findComment.mockResolvedValueOnce(null);
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'gone' }));
    reads.findComment.mockResolvedValueOnce({ id: 'c2', ticketId: 'other', body: 'x', authorUserId: 'u' });
    await sub.handle(envelope('COMMENT_ADDED', { commentId: 'c2' }));
    expect(writer.deliver).not.toHaveBeenCalled();
  });

  it('skips malformed payloads and unhandled actions without reading anything', async () => {
    const { sub, reads } = setup();
    await sub.handle(null);
    await sub.handle({ action: 'assigned' });
    await sub.handle(envelope('TICKET_DELETED'));
    expect(reads.findTicket).not.toHaveBeenCalled();
  });

  it('propagates a database failure so the outbox retries', async () => {
    const { sub, writer } = setup();
    writer.deliver.mockRejectedValueOnce(new Error('db down'));
    await expect(sub.handle(envelope('status_changed', { fromStatus: 'A', newStatus: 'B' }))).rejects.toThrow('db down');
  });

  it('TICKET_UPDATED notifies users newly mentioned in the description (S4a slice 3)', async () => {
    const { sub, mentions, delivered } = setup();
    const prev = '@[a](user:c000000000000000000000001)';
    const next = `${prev} @[b](user:c000000000000000000000002)`;
    mentions.mentionedUserIds.mockResolvedValueOnce(['c000000000000000000000001', 'c000000000000000000000002']);
    await sub.handle(envelope('TICKET_UPDATED', { description: next, previousDescription: prev }));
    expect(mentions.mentionedUserIds).toHaveBeenCalledWith('p1', next);
    expect(delivered()).toEqual([
      expect.objectContaining({ userId: 'c000000000000000000000002', kind: 'ticket_mentioned', category: 'MENTIONED' }),
    ]);
  });

  it('TICKET_UPDATED without a description change or with no new mention does nothing (S4a slice 3)', async () => {
    const { sub, mentions, writer } = setup();
    await sub.handle(envelope('TICKET_UPDATED', { title: 'renamed' }));
    const same = '@[a](user:c000000000000000000000001)';
    mentions.mentionedUserIds.mockResolvedValueOnce(['c000000000000000000000001']);
    await sub.handle(envelope('TICKET_UPDATED', { description: same, previousDescription: same }));
    expect(writer.deliver).not.toHaveBeenCalled();
  });
});
