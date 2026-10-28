import type { ApprovalRequestRecord } from '../domain/approval.domain';

/**
 * US-003: the pending outcome of a gated write, as a handler throws it.
 *
 * Nest re-applies a route's static status after the interceptors run, so a handler cannot answer 202
 * by returning it on a 201 or 204 route. It throws this instead, and `ApprovalPendingFilter` answers
 * the request summary through the http adapter. Nothing is rolled back by the throw: the gate already
 * committed the request in its own bookkeeping transaction.
 */
export class ApprovalPending extends Error {
  readonly request: ApprovalRequestRecord;

  constructor(request: ApprovalRequestRecord) {
    super(`approval pending: ${request.id}`);
    this.name = 'ApprovalPending';
    this.request = request;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
