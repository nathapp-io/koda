import type { ApprovalOption } from '../common/protocol';
import type { ApprovalDecision } from './domain/approval.domain';

type Checked = { ok: true; choice: ApprovalOption; status: 'approved' | 'rejected' } | { ok: false; reason: string };

/** Spec §1.3 / plan D267: a human never approves text they could not see, nor an option nax did not offer. */
export function checkBashDecision(payload: Record<string, unknown>, decision: ApprovalDecision): Checked {
  if (decision === 'deny') return { ok: true, choice: 'deny', status: 'rejected' };
  if (decision !== 'allow' && decision !== 'allow_for_job') return { ok: false, reason: `${decision} does not apply to a bash approval` };
  if (payload['commandTruncated'] === true) return { ok: false, reason: 'the command was truncated; it can only be denied' };
  const options = Array.isArray(payload['options']) ? payload['options'] : [];
  if (decision === 'allow') return options.includes('allow') ? { ok: true, choice: 'allow', status: 'approved' } : { ok: false, reason: 'nax did not offer allow for this ask' };
  const offered = options.includes('allow-remember');
  return offered ? { ok: true, choice: 'allow-remember', status: 'approved' } : { ok: false, reason: 'nax did not offer allow-remember for this ask' };
}
