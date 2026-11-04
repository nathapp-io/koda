import { ValidationAppException } from '@nathapp/nestjs-common';
import type { ThreadAnswerPayload } from '../common/thread-jobs';

/**
 * thread-agents-modes US-008: the decision half of a `THREAD_ANSWER`.
 *
 * A text answer and a decision share one command type and one route key; what separates them is the payload. The
 * decision form carries `{ requestId, decision }`, which `command()` checks against `pendingApprovals` instead of
 * `pendingQuestion`, so an approval decision never satisfies a text question and the reverse.
 */
export const THREAD_APPROVAL_DECISIONS = ['allow', 'deny'] as const;
export type ThreadApprovalDecision = (typeof THREAD_APPROVAL_DECISIONS)[number];
/** The decision form of the answer payload, as the runner reads it (US-009). */
export type ThreadDecisionPayload = Extract<ThreadAnswerPayload, { decision: ThreadApprovalDecision }>;

/** At most this many characters in a request id, the same bound the text answer takes. */
export const THREAD_REQUEST_ID_MAX = 128;

/** The request id from a route parameter: a non-empty string within the stored bound. */
export function validateAnswerRequestId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > THREAD_REQUEST_ID_MAX) {
    throw new ValidationAppException({ reason: 'requestId' }, 'threads.input');
  }
  return value;
}

/** The stored decision of a payload, or null when the payload is a text answer. */
export function readApprovalDecision(value: unknown): ThreadApprovalDecision | null {
  return value === 'allow' || value === 'deny' ? value : null;
}

/** `allow` or `deny`; anything else names `decision`, so a client typo is not a silent refusal. */
export function validateApprovalDecision(value: unknown): ThreadApprovalDecision {
  const decision = readApprovalDecision(value);
  if (decision === null) throw new ValidationAppException({ reason: 'decision' }, 'threads.input');
  return decision;
}

/** The payload a decision sends; the shape `pendingApprovals` is checked against in `command()`. */
export function decisionPayload(requestId: string, decision: ThreadApprovalDecision): ThreadDecisionPayload {
  return { requestId, decision };
}
