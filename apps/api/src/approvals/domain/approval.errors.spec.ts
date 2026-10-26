import * as errors from './approval.errors';

describe('approval domain errors', () => {
  it('preserves the Error prototype, class name and constructor payload', () => {
    const cases = [
      [new errors.InvalidApprovalPolicyError('pattern'), 'violation', 'pattern'],
      [new errors.ApprovalPolicyConflictError('selector'), 'selector', 'selector'],
      [new errors.ApprovalPolicyNotFoundError('p1'), 'id', 'p1'],
      [new errors.ApprovalPolicySelfApplicationError('selector'), 'policySelector', 'selector'],
      [new errors.UnregisteredApprovalCommandError('ticket.delete'), 'key', 'ticket.delete'],
      [new errors.ApprovalRequestNotFoundError('r1'), 'id', 'r1'],
      [new errors.ApprovalRequestNotPendingError('approved'), 'status', 'approved'],
      [new errors.ApprovalRequestExpiredError('r1'), 'id', 'r1'],
      [new errors.ApprovalDecideForbiddenError('tier-too-low'), 'reason', 'tier-too-low'],
    ] as const;
    for (const [error, field, value] of cases) {
      expect(error).toBeInstanceOf(Error);
      expect(Object.getPrototypeOf(error)).toBe(errors[error.name as keyof typeof errors].prototype);
      expect(error).toHaveProperty(field, value);
      expect(error.message).not.toBe('');
    }
  });
});
