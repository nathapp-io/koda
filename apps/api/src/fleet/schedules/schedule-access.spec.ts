import type { OwnerAccess } from './domain/schedule.domain';
import { mayDispatch } from './schedule-access';

/**
 * Permissions P1d US-005 (spec AC-13): the permission to fire a schedule is the owner's, read from the
 * owner's effective keys — not from a legacy role value. `mayDispatch` answers yes only when the owner
 * still exists, is not disabled, and holds `fleet.job.dispatch` in the schedule's project.
 */
const DISPATCH = ['fleet.job.dispatch'];

describe('mayDispatch', () => {
  it('AC-21: an existing, enabled owner holding fleet.job.dispatch may dispatch', () => {
    expect(mayDispatch({ exists: true, disabled: false }, new Set(DISPATCH))).toBe(true);
  });

  it('AC-22: a disabled owner may not dispatch, whatever keys it holds', () => {
    expect(mayDispatch({ exists: true, disabled: true }, new Set(DISPATCH))).toBe(false);
  });

  it('AC-23: a missing owner may not dispatch', () => {
    expect(mayDispatch({ exists: false, disabled: false }, new Set(DISPATCH))).toBe(false);
  });

  it('AC-24: an owner whose keys do not include fleet.job.dispatch may not dispatch', () => {
    expect(mayDispatch({ exists: true, disabled: false }, new Set())).toBe(false);
  });

  it('reads only the dispatch key: another fleet.job key or a read key does not fire', () => {
    expect(mayDispatch({ exists: true, disabled: false }, new Set(['fleet.job.read', 'fleet.job.cancel', 'fleet.schedule.read']))).toBe(false);
  });

  it.each<[string, OwnerAccess]>([
    ['a project developer', { exists: true, disabled: false }],
    ['an agent owner (never disabled by status)', { exists: true, disabled: false }],
  ])('accepts %s holding the dispatch key', (_name, access) => {
    expect(mayDispatch(access, new Set(DISPATCH))).toBe(true);
  });
});
