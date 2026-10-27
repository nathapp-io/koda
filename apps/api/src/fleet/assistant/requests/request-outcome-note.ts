import type { ApprovalRequestStatus } from '../../../approvals/domain/approval.domain';

export const NOTE_RESULT_MAX = 500;

export interface RequestOutcome {
  requestId: string;
  tool: string;
  status: ApprovalRequestStatus;
  result: unknown;
}

/** English, agent-facing transcript text; the complete result stays on the request. */
export function requestOutcomeNote({ requestId, tool, status, result }: RequestOutcome): string {
  const head = `Action ${requestId} (${tool})`;
  const value = result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown> : {};
  switch (status) {
    case 'executed': {
      const text = typeof value.text === 'string' ? value.text : '';
      const capped = text.length > NOTE_RESULT_MAX ? `${text.slice(0, NOTE_RESULT_MAX)}…` : text;
      return `${head} was approved and done: ${capped}`;
    }
    case 'failed': return `${head} was approved but failed: ${value.name === 'NotFoundAppException' ? 'not_found' : `error: ${tool} failed`}`;
    case 'rejected': return `${head} was rejected.`;
    case 'expired': return `${head} expired without a decision.`;
    case 'cancelled': return `${head} was cancelled.`;
    default: throw new Error(`request ${requestId} is ${status}, which has no outcome note`);
  }
}
