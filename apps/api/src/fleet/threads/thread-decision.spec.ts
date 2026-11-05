import { ValidationAppException } from '@nathapp/nestjs-common';
import { decisionPayload, readApprovalDecision, validateAnswerRequestId, validateApprovalDecision } from './thread-decision';

/** thread-agents-modes US-008: the decision payload's own bounds, before it reaches the thread's pending list. */
describe('thread approval decision input', () => {
  it('reads allow and deny, and nothing else, as a decision', () => {
    expect(readApprovalDecision('allow')).toBe('allow');
    expect(readApprovalDecision('deny')).toBe('deny');
    for (const value of ['maybe', '', null, undefined, 1, true, { decision: 'allow' }]) expect(readApprovalDecision(value)).toBeNull();
  });

  it('validates a decision and names decision when it is unknown', () => {
    expect(validateApprovalDecision('deny')).toBe('deny');
    expect(() => validateApprovalDecision('maybe')).toThrow(expect.objectContaining({ args: { reason: 'decision' } }));
    expect(() => validateApprovalDecision('maybe')).toThrow(ValidationAppException);
  });

  it('bounds the request id from the route and names requestId when it is not usable', () => {
    expect(validateAnswerRequestId('r1')).toBe('r1');
    expect(validateAnswerRequestId('x'.repeat(128))).toBe('x'.repeat(128));
    for (const value of ['', 'x'.repeat(129), null, undefined, 7, ['r1']]) {
      expect(() => validateAnswerRequestId(value)).toThrow(expect.objectContaining({ args: { reason: 'requestId' } }));
    }
  });

  it('builds the payload the runner reads: the request id and the decision, nothing else', () => {
    expect(decisionPayload('r1', 'allow')).toEqual({ requestId: 'r1', decision: 'allow' });
  });
});
