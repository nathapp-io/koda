import {
  parseTicketPrLinkRetryPayload,
  TICKET_PR_LINK_RETRY,
  ticketPrLinkRetryPayload,
} from './ticket-pr-link';

/** Review B2: the payload of the durable retry of a classic auto-PR link write. */
describe('classic auto-PR link retry payload', () => {
  it('names the outbox type the subscriber registers', () => {
    expect(TICKET_PR_LINK_RETRY).toBe('ticket_pr_link_retry');
  });

  it('carries the project, its key and the ticket', () => {
    expect(ticketPrLinkRetryPayload({ id: 'proj-1', key: 'KODA' }, 'ticket-1')).toEqual({
      projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1',
    });
  });

  it('round-trips through the parser', () => {
    const payload = ticketPrLinkRetryPayload({ id: 'proj-1', key: 'KODA' }, 'ticket-1');
    expect(parseTicketPrLinkRetryPayload(payload)).toEqual(payload);
  });

  it.each([
    ['null', null],
    ['a string', 'ticket-1'],
    ['a missing ticket', { projectId: 'proj-1', projectKey: 'KODA' }],
    ['an empty project key', { projectId: 'proj-1', projectKey: '', ticketId: 'ticket-1' }],
    ['a non-string ticket', { projectId: 'proj-1', projectKey: 'KODA', ticketId: 7 }],
  ])('answers null for %s', (_case, payload) => {
    expect(parseTicketPrLinkRetryPayload(payload)).toBeNull();
  });
});
