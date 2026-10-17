import type { PendingActionRecord } from './pending-action.domain';

/** 2a-D9: the longest `<result>` an outcome note carries; the full result stays on the action. */
export const NOTE_RESULT_MAX = 500;

type NoteAction = Pick<PendingActionRecord, 'id' | 'tool' | 'status' | 'result'>;

const capped = (result: string | null): string => {
  const text = result ?? '';
  return text.length > NOTE_RESULT_MAX ? `${text.slice(0, NOTE_RESULT_MAX)}…` : text;
};

/**
 * 2a-D9: the system note a terminal outcome leaves in the action's thread. English only, like the agent's own
 * instructions: it is written for the agent first and stored once for every reader.
 */
export function outcomeNote(action: NoteAction): string {
  const head = `Action ${action.id} (${action.tool})`;
  switch (action.status) {
    case 'EXECUTED': return `${head} was approved and done: ${capped(action.result)}`;
    case 'FAILED': return `${head} was approved but failed: ${capped(action.result)}`;
    case 'REJECTED': return `${head} was rejected by the user.`;
    case 'EXPIRED': return `${head} expired without a decision.`;
    default: throw new Error(`action ${action.id} is ${action.status}, which has no outcome note`);
  }
}
