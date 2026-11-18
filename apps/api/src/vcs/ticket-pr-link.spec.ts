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

  // Review B2 (fix round 2): the intent records the repository and branch it works on, so its retry adopts that
  // branch's PR after the ticket title or the project's connection moved.
  it('carries the recorded forge target and branch', () => {
    const target = { provider: 'github', repoOwner: 'acme', repoName: 'widgets', branchName: 'KODA-7-fix-login' };

    expect(ticketPrLinkRetryPayload({ id: 'proj-1', key: 'KODA' }, 'ticket-1', target)).toEqual({
      projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1', ...target,
    });
    expect(parseTicketPrLinkRetryPayload(
      ticketPrLinkRetryPayload({ id: 'proj-1', key: 'KODA' }, 'ticket-1', target),
    )).toEqual({ projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1', ...target });
  });

  it('parses a payload recorded before the intent carried a target', () => {
    expect(parseTicketPrLinkRetryPayload({ projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' }))
      .toEqual({ projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' });
  });

  it('drops a half-recorded target instead of reading it', () => {
    expect(parseTicketPrLinkRetryPayload({
      projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1', repoOwner: 'acme', repoName: 'widgets',
    })).toEqual({ projectId: 'proj-1', projectKey: 'KODA', ticketId: 'ticket-1' });
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
