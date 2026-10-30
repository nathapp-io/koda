import type { ApprovalPolicyViolation, ApprovalRequestStatus, EligibilityRefusal } from './approval.domain';

export class InvalidApprovalPolicyError extends Error {
  constructor(readonly violation: ApprovalPolicyViolation) {
    super(`Invalid approval policy: ${violation}`);
    this.name = 'InvalidApprovalPolicyError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalPolicyConflictError extends Error {
  constructor(readonly selector: string) {
    super(`Approval policy already exists: ${selector}`);
    this.name = 'ApprovalPolicyConflictError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalPolicyNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Approval policy not found: ${id}`);
    this.name = 'ApprovalPolicyNotFoundError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalPolicySelfApplicationError extends Error {
  constructor(readonly policySelector: string) {
    super(`Approval policy applies to its own write: ${policySelector}`);
    this.name = 'ApprovalPolicySelfApplicationError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class UnregisteredApprovalCommandError extends Error {
  constructor(readonly key: string) {
    super(`Unregistered approval command: ${key}`);
    this.name = 'UnregisteredApprovalCommandError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalRequestNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Approval request not found: ${id}`);
    this.name = 'ApprovalRequestNotFoundError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalRequestNotPendingError extends Error {
  constructor(readonly status: ApprovalRequestStatus) {
    super(`Approval request is not pending: ${status}`);
    this.name = 'ApprovalRequestNotPendingError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalRequestExpiredError extends Error {
  constructor(readonly id: string) {
    super(`Approval request expired: ${id}`);
    this.name = 'ApprovalRequestExpiredError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
/**
 * A redemption asked for a request it cannot redeem (US-004): another key, variant or project, a
 * request that is not redeemable, or a re-sent body whose redacted form is not the stored input.
 */
export class ApprovalRedeemMismatchError extends Error {
  constructor(readonly id: string) {
    super(`Approval request cannot be redeemed: ${id}`);
    this.name = 'ApprovalRedeemMismatchError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
/** A deferred decision lost its pending inner request, not the outer execution's row lock. */
export class DeferredDecisionRefusedError extends Error {
  constructor(readonly reason: 'not-pending' | 'expired', readonly status?: string) {
    super(`Deferred decision refused: ${reason}`);
    this.name = 'DeferredDecisionRefusedError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
export class ApprovalDecideForbiddenError extends Error {
  constructor(readonly reason: EligibilityRefusal) {
    super(`Approval decision forbidden: ${reason}`);
    this.name = 'ApprovalDecideForbiddenError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ApprovalCancelForbiddenError extends Error {
  constructor(readonly id: string) {
    super(`Approval cancellation forbidden: ${id}`);
    this.name = 'ApprovalCancelForbiddenError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Why a decider's params were refused. */
export type DecisionParamsRefusal = 'not-accepted' | 'too-large' | 'invalid';

/**
 * A decider sent params the request's command cannot honour: it takes none, the value is over the
 * size cap, or the command's `parseDecision` (or the frozen input's own `parse`) refused them.
 */
export class ApprovalDecisionParamsInvalidError extends Error {
  constructor(readonly reason: DecisionParamsRefusal) {
    super(`Invalid decision params: ${reason}`);
    this.name = 'ApprovalDecisionParamsInvalidError'; Object.setPrototypeOf(this, new.target.prototype);
  }
}
