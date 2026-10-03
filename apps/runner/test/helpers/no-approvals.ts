import type { ApprovalRelay } from '../../src/approvals/approval-relay';

/** A raw-only executor never opens a relay; tests that do not exercise it pass this (mirrors NO_CREDENTIALS). */
export const NO_APPROVALS: Pick<ApprovalRelay, 'open' | 'close' | 'resume'> = {
  open: async () => { throw new Error('NO_APPROVALS: a test opened a relay without providing one'); },
  close: async () => undefined,
  resume: async () => undefined,
};
