import { ticketDraft, TicketDraftInput } from './ticket-notification-text';

const input = (over: Partial<TicketDraftInput> = {}): TicketDraftInput => ({
  kind: 'ticket_assigned', userId: 'u1', eventId: 'evt-1', actorId: 'u2', projectId: 'p1', slug: 'koda', ref: 'KODA-12',
  ticketTitle: 'Fix login', actorName: 'Alice', excerpt: null, ...over,
});

describe('ticketDraft (S4a kinds table)', () => {
  it('builds an assignment', () => {
    expect(ticketDraft(input())).toEqual({
      userId: 'u1', projectId: 'p1', category: 'ASSIGNED', kind: 'ticket_assigned',
      title: 'Alice assigned you KODA-12: Fix login', body: null, link: '/koda/tickets/KODA-12',
      params: { ref: 'KODA-12', ticketTitle: 'Fix login', actorName: 'Alice' },
      sourceType: 'ticket_event', sourceId: 'evt-1', actorId: 'u2',
    });
  });

  it('builds a mention, a comment and a status change', () => {
    expect(ticketDraft(input({ kind: 'ticket_mentioned', excerpt: 'hey @x look' }))).toMatchObject({
      category: 'MENTIONED', title: 'Alice mentioned you on KODA-12', body: 'hey @x look',
    });
    expect(ticketDraft(input({ kind: 'ticket_commented', excerpt: 'done' }))).toMatchObject({
      category: 'WATCHED_ACTIVITY', title: 'Alice commented on KODA-12', body: 'done',
    });
    expect(ticketDraft(input({ kind: 'ticket_status_changed', fromStatus: 'VERIFIED', newStatus: 'IN_PROGRESS' }))).toMatchObject({
      category: 'WATCHED_ACTIVITY', title: 'KODA-12 moved VERIFIED → IN_PROGRESS', body: 'Fix login',
      params: { ref: 'KODA-12', ticketTitle: 'Fix login', actorName: 'Alice', fromStatus: 'VERIFIED', newStatus: 'IN_PROGRESS' },
    });
  });

  it('truncates a long title and a long excerpt (Review Focus 4)', () => {
    const draft = ticketDraft(input({ kind: 'ticket_commented', ticketTitle: 'T'.repeat(500), excerpt: `${'word '.repeat(400)}end` }));
    expect(draft.title.length).toBeLessThanOrEqual(200);
    expect(draft.body?.length).toBeLessThanOrEqual(280);
    expect(draft.body?.endsWith('…')).toBe(true);
    const assigned = ticketDraft(input({ ticketTitle: 'T'.repeat(500) }));
    expect(assigned.title).toHaveLength(200);
    expect(String(assigned.params.ticketTitle).length).toBeLessThanOrEqual(200);
  });
});
