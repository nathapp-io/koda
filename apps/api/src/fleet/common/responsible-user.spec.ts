import { responsibleUserOf } from './responsible-user';

/**
 * Permissions P1d US-002 — the mapping every fleet row that stores a requester uses for
 * `FleetActivity.responsibleUserId`. A job requested by an agent answers null: the column is a user's.
 */
describe('responsibleUserOf', () => {
  it('answers null for a job an agent requested', () => {
    expect(responsibleUserOf({ requestedById: 'a1', requestedByType: 'AGENT' })).toBeNull();
  });

  it('answers the requester for a job a user requested', () => {
    expect(responsibleUserOf({ requestedById: 'u1', requestedByType: 'USER' })).toBe('u1');
  });

  it('answers the requester when the row predates the requester type', () => {
    expect(responsibleUserOf({ requestedById: 'u1' })).toBe('u1');
  });

  it('ignores an unknown stored value as a user (records written before the column existed)', () => {
    expect(responsibleUserOf({ requestedById: 'u1', requestedByType: 'SOMETHING' })).toBe('u1');
  });
});
