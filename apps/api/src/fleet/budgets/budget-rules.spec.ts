import {
  budgetReason, hardReached, isAboveSpend, isEffectivelyPaused, isStaleMonthlyPause, jobGateKeys, jobSpendKeys,
  LIFETIME_WINDOW_START, PauseSnapshot, scopeKeyOf, spendSince, warnReached, windowStart,
} from './budget-rules';
import type { BudgetPolicyRecord } from './domain/budget.domain';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const OCT = new Date('2026-10-01T00:00:00.000Z');
const SEP = new Date('2026-09-01T00:00:00.000Z');

const policy = (over: Partial<BudgetPolicyRecord> = {}): BudgetPolicyRecord => ({
  id: 'p1', scopeType: 'project', scopeId: 'proj-1', scopeKey: 'project:proj-1', projectId: 'proj-1',
  windowKind: 'calendar_month_utc', amountUsd: '10', warnPercent: 80, hardStop: true, runningJobs: 'finish',
  pausedAt: null, pausedWindowStart: null, createdById: 'u1', updatedById: 'u1', createdAt: SEP, updatedAt: SEP, ...over,
});

describe('budget rules (S1b §2.1-§2.3)', () => {
  it('starts a monthly window at the first instant of the UTC month, and lifetime at the epoch (D155)', () => {
    expect(windowStart('calendar_month_utc', NOW)).toEqual(OCT);
    expect(windowStart('lifetime', NOW)).toEqual(LIFETIME_WINDOW_START);
    expect(LIFETIME_WINDOW_START.toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(spendSince('calendar_month_utc', NOW)).toEqual(OCT);
    expect(spendSince('lifetime', NOW)).toBeNull();
  });

  it('uses the UTC month whatever the local zone says', () => {
    // 2026-10-31T23:30 at UTC-8 is already 2026-11-01T07:30Z: the November window.
    const lateLocal = new Date('2026-10-31T23:30:00.000-08:00');
    expect(windowStart('calendar_month_utc', lateLocal)).toEqual(new Date('2026-11-01T00:00:00.000Z'));
    expect(windowStart('calendar_month_utc', new Date('2026-12-31T23:59:59.999Z'))).toEqual(new Date('2026-12-01T00:00:00.000Z'));
  });

  it('builds scope keys and the stop reason', () => {
    expect(scopeKeyOf('global', null)).toBe('global');
    expect(scopeKeyOf('repo', 'r1')).toBe('repo:r1');
    expect(budgetReason('p9')).toBe('budget:p9');
  });

  it('lists gate keys in precedence order, with the pinned runner only when pinned', () => {
    expect(jobGateKeys({ projectId: 'p', repoId: 'r', pinnedRunnerId: null })).toEqual(['global', 'project:p', 'repo:r']);
    expect(jobGateKeys({ projectId: 'p', repoId: 'r', pinnedRunnerId: 'x' })).toEqual(['global', 'project:p', 'repo:r', 'runner:x']);
    expect(jobSpendKeys({ projectId: 'p', repoId: 'r', runnerId: 'y' })).toEqual(['global', 'project:p', 'repo:r', 'runner:y']);
    expect(jobSpendKeys({ projectId: 'p', repoId: 'r', runnerId: null })).toEqual(['global', 'project:p', 'repo:r']);
  });

  it('enforces a monthly pause only in its own window; a lifetime pause always', () => {
    expect(isEffectivelyPaused(policy(), NOW)).toBe(false);
    expect(isEffectivelyPaused(policy({ pausedAt: OCT, pausedWindowStart: OCT }), NOW)).toBe(true);
    const stale = policy({ pausedAt: SEP, pausedWindowStart: SEP });
    expect(isEffectivelyPaused(stale, NOW)).toBe(false);
    expect(isStaleMonthlyPause(stale, NOW)).toBe(true);
    expect(isStaleMonthlyPause(policy({ pausedAt: OCT, pausedWindowStart: OCT }), NOW)).toBe(false);
    const lifetime = policy({ windowKind: 'lifetime', pausedAt: SEP, pausedWindowStart: LIFETIME_WINDOW_START });
    expect(isEffectivelyPaused(lifetime, NOW)).toBe(true);
    expect(isStaleMonthlyPause(lifetime, NOW)).toBe(false);
  });

  it('compares decimal thresholds exactly', () => {
    expect(hardReached('0.3', '0.3')).toBe(true);
    expect(hardReached('0.2999', '0.3')).toBe(false);
    expect(warnReached('8', '10', 80)).toBe(true);
    expect(warnReached('7.9999', '10', 80)).toBe(false);
    // 1/3 of 0.0001 does not terminate; the comparison must still be exact.
    expect(warnReached('0.0000', '0.0001', 33)).toBe(false);
    expect(warnReached('0.0001', '0.0003', 33)).toBe(true);
    expect(warnReached('100', '10', null)).toBe(false);
    expect(isAboveSpend('10.0001', '10')).toBe(true);
    expect(isAboveSpend('10', '10')).toBe(false);
  });

  it('matches paused policies by key order and finds paused runners (plan D158)', () => {
    const projectPause = policy({ pausedAt: OCT, pausedWindowStart: OCT });
    const repoPause = policy({ id: 'p2', scopeType: 'repo', scopeId: 'r', scopeKey: 'repo:r', pausedAt: OCT, pausedWindowStart: OCT });
    const runnerPause = policy({ id: 'p3', scopeType: 'runner', scopeId: 'x', scopeKey: 'runner:x', projectId: null, pausedAt: OCT, pausedWindowStart: OCT });
    const stale = policy({ id: 'p4', scopeKey: 'global', scopeType: 'global', scopeId: null, pausedAt: SEP, pausedWindowStart: SEP });
    const snap = PauseSnapshot.of([repoPause, projectPause, runnerPause, stale], NOW);
    expect(snap.match(['global', 'project:proj-1', 'repo:r'])?.id).toBe('p1');
    expect(snap.match(['global', 'repo:r'])?.id).toBe('p2');
    expect(snap.match(['global'])).toBeNull();
    expect(snap.runnerPaused('x')).toBe(true);
    expect(snap.runnerPaused('y')).toBe(false);
  });
});
