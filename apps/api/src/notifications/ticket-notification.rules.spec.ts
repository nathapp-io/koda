import { ticketRecipients, TicketEventFacts, watchEntries } from './ticket-notification.rules';

const facts = (over: Partial<TicketEventFacts>): TicketEventFacts => ({
  action: 'COMMENT_ADDED', reporterId: null, assigneeUserId: null, commentAuthorId: null, mentionedIds: [], ...over,
});

describe('ticket notification rules (S4a §2.2)', () => {
  it.each([
    ['TICKET_CREATED', facts({ action: 'TICKET_CREATED', reporterId: 'r', mentionedIds: ['m'] }), [{ userId: 'r', reason: 'REPORTER' }, { userId: 'm', reason: 'MENTIONED' }]],
    ['assigned', facts({ action: 'assigned', assigneeUserId: 'a' }), [{ userId: 'a', reason: 'ASSIGNEE' }]],
    ['assigned to nobody/agent', facts({ action: 'assigned' }), []],
    ['COMMENT_ADDED', facts({ commentAuthorId: 'c', mentionedIds: ['m'] }), [{ userId: 'c', reason: 'COMMENTER' }, { userId: 'm', reason: 'MENTIONED' }]],
    ['COMMENT_ADDED by an agent', facts({ commentAuthorId: null }), []],
    ['status_changed', facts({ action: 'status_changed' }), []],
  ])('watch entries for %s', (_name, f, expected) => {
    expect(watchEntries(f)).toEqual(expected);
  });

  it('assignment notifies the assignee only, whatever the watchers', () => {
    expect(ticketRecipients(facts({ action: 'assigned', assigneeUserId: 'a' }), ['w1', 'a'])).toEqual([{ userId: 'a', kind: 'ticket_assigned' }]);
  });

  it('a comment notifies mentions as MENTIONED and other unmuted watchers as WATCHED_ACTIVITY, one each', () => {
    expect(ticketRecipients(facts({ commentAuthorId: 'c', mentionedIds: ['m', 'w2'] }), ['c', 'w1', 'w2'])).toEqual([
      { userId: 'm', kind: 'ticket_mentioned' },
      { userId: 'w2', kind: 'ticket_mentioned' },
      { userId: 'c', kind: 'ticket_commented' },
      { userId: 'w1', kind: 'ticket_commented' },
    ]);
  });

  it('a mention reaches a muted watcher (muted users are absent from the watcher list but present in mentions)', () => {
    expect(ticketRecipients(facts({ mentionedIds: ['muted'] }), [])).toEqual([{ userId: 'muted', kind: 'ticket_mentioned' }]);
  });

  it('a status change notifies unmuted watchers; creation notifies mentions only', () => {
    expect(ticketRecipients(facts({ action: 'status_changed' }), ['w1', 'w1', 'w2'])).toEqual([
      { userId: 'w1', kind: 'ticket_status_changed' },
      { userId: 'w2', kind: 'ticket_status_changed' },
    ]);
    expect(ticketRecipients(facts({ action: 'TICKET_CREATED', reporterId: 'r', mentionedIds: ['m'] }), ['r'])).toEqual([
      { userId: 'm', kind: 'ticket_mentioned' },
    ]);
  });
});
