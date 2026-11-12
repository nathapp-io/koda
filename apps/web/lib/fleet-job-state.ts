/**
 * The dot beside a fleet job's state label, on the same status tokens as the ticket chips
 * (`lib/ticket-chips.ts`): waiting is neutral, live work is the accent, finished work is done,
 * a run that needs a human is review, and a broken run is rejected. The label always renders
 * next to the dot, so state is never color alone.
 */
const JOB_STATE_DOT: Readonly<Record<string, string>> = {
  QUEUED: 'bg-status-todo',
  ASSIGNED: 'bg-status-todo',
  RUNNING: 'bg-status-active',
  UPLOADING: 'bg-status-active',
  COMPLETED: 'bg-status-done',
  ESCALATED: 'bg-status-review',
  FAILED: 'bg-status-rejected',
  CRASHED: 'bg-status-rejected',
  CANCELLED: 'bg-status-todo',
}

export function jobStateDotClass(state: string): string {
  return JOB_STATE_DOT[state] ?? 'bg-muted-foreground'
}
