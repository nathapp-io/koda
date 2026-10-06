import { FAILURE_STATES, MAX_REASON_CHARS, failureCommentBody } from './failure-comment';

const job = (over: Record<string, unknown> = {}) => ({
  id: 'job1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'FAILED', leaseEpoch: 1,
  stateReason: 'exit 1', escalationReason: null, requestedById: 'u', ...over,
});

describe('failureCommentBody (C9 §3.2, D453)', () => {
  it('names the command, job, state and reason, and links the job page', () => {
    expect(failureCommentBody(job())).toBe('Fleet RUN job job1 ended FAILED: exit 1\n/web/fleet/jobs/job1');
  });

  it('prefers the escalation reason for ESCALATED', () => {
    expect(failureCommentBody(job({ state: 'ESCALATED', escalationReason: 'review blocked', stateReason: 'x' }))).toContain('ended ESCALATED: review blocked');
  });

  it('falls back to the state reason, then to a fixed text', () => {
    expect(failureCommentBody(job({ state: 'ESCALATED', escalationReason: null, stateReason: 'finish escalated' }))).toContain(': finish escalated');
    expect(failureCommentBody(job({ state: 'CRASHED', stateReason: null }))).toContain('ended CRASHED: no reason recorded');
    expect(failureCommentBody(job({ stateReason: '   ' }))).toContain(': no reason recorded');
  });

  it(`truncates the reason to ${MAX_REASON_CHARS} characters`, () => {
    const body = failureCommentBody(job({ stateReason: 'x'.repeat(2000) }));
    const reason = body.split('\n')[0].split(': ')[1];
    expect(reason).toHaveLength(MAX_REASON_CHARS);
    expect(reason.endsWith('...')).toBe(true);
  });

  it('covers exactly the failure states', () => {
    expect([...FAILURE_STATES].sort()).toEqual(['CRASHED', 'ESCALATED', 'FAILED']);
  });
});
