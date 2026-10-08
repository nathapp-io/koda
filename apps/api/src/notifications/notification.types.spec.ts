import { BODY_MAX, NOTIFICATION_CATEGORIES, TITLE_MAX, truncate, WATCH_REASONS } from './notification.types';

describe('notification types (S4a)', () => {
  it('pins the categories and watch reasons', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']);
    expect(WATCH_REASONS).toEqual(['REPORTER', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL']);
    expect([TITLE_MAX, BODY_MAX]).toEqual([200, 280]);
  });

  it('leaves short text alone and cuts long text to exactly max chars ending in an ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('a'.repeat(10), 10)).toBe('a'.repeat(10));
    const cut = truncate('a'.repeat(11), 10);
    expect(cut).toBe(`${'a'.repeat(9)}…`);
    expect(cut).toHaveLength(10);
  });

  it('never splits a surrogate pair', () => {
    const cut = truncate(`${'a'.repeat(8)}😀😀`, 10);
    expect(cut).toBe(`${'a'.repeat(8)}…`);
  });

  it('collapses whitespace so a multi-line comment reads as one line', () => {
    expect(truncate('line one\n\n  line two', 50)).toBe('line one line two');
  });
});
