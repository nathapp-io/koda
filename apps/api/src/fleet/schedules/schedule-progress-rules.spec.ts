import { judgeEndedJob, ProgressVerdict, readProgress } from './schedule-progress-rules';

type Row = [string, string, unknown, number, ProgressVerdict];

const ROWS: Row[] = [
  // [name, state, progress, lastPassedCount, verdict]
  ['rule 1: COMPLETED disables, whatever the progress', 'COMPLETED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'completed' }],
  ['rule 1: COMPLETED with no progress at all', 'COMPLETED', null, 0, { kind: 'disable', reason: 'completed' }],
  ['rule 2: CANCELLED is ignored', 'CANCELLED', { passed: 5, total: 5 }, 0, { kind: 'ignore' }],
  ['rule 3: null progress is no progress', 'FAILED', null, 2, { kind: 'no_progress' }],
  ['rule 3: a string is no progress', 'FAILED', 'garbage', 2, { kind: 'no_progress' }],
  ['rule 3: an array is no progress', 'FAILED', [3, 3], 2, { kind: 'no_progress' }],
  ['rule 3: a non-numeric passed', 'FAILED', { passed: '2', total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: a negative passed', 'FAILED', { passed: -1, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: a fractional passed', 'FAILED', { passed: 1.5, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 3: NaN passed', 'FAILED', { passed: Number.NaN, total: 3 }, 0, { kind: 'no_progress' }],
  ['rule 4: every story passed but the run FAILED', 'FAILED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4: every story passed, ESCALATED', 'ESCALATED', { passed: 3, total: 3 }, 0, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4: every story passed, CRASHED', 'CRASHED', { passed: 3, total: 3 }, 3, { kind: 'disable', reason: 'finish_failed' }],
  ['rule 4 needs total > 0: 0 of 0 is no progress', 'FAILED', { passed: 0, total: 0 }, 0, { kind: 'no_progress' }],
  ['rule 4 needs a numeric total: passed alone can be progress', 'FAILED', { passed: 2 }, 0, { kind: 'progress', passed: 2 }],
  ['rule 5: more passed than before is progress', 'FAILED', { passed: 2, total: 5 }, 1, { kind: 'progress', passed: 2 }],
  ['rule 5 holds for CRASHED too', 'CRASHED', { passed: 2, total: 5 }, 1, { kind: 'progress', passed: 2 }],
  ['rule 5 holds for ESCALATED too', 'ESCALATED', { passed: 4, total: 5 }, 1, { kind: 'progress', passed: 4 }],
  ['rule 6: the same count is no progress', 'FAILED', { passed: 2, total: 5 }, 2, { kind: 'no_progress' }],
  ['rule 6: a lower count is no progress', 'FAILED', { passed: 1, total: 5 }, 2, { kind: 'no_progress' }],
];

describe('judgeEndedJob (S1b §3.3 rules 1-6, in order)', () => {
  it.each(ROWS)('%s', (_name, state, progress, last, verdict) => {
    expect(judgeEndedJob({ state, progress }, last)).toEqual(verdict);
  });
});

describe('readProgress', () => {
  it('reads integer counts and nothing else', () => {
    expect(readProgress({ passed: 2, total: 5, failed: 1 })).toEqual({ passed: 2, total: 5 });
    expect(readProgress({ passed: 2.5, total: '5' })).toEqual({ passed: null, total: null });
    expect(readProgress(undefined)).toEqual({ passed: null, total: null });
  });
});
