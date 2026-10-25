/**
 * Permissions P2 US-002: the VCS sync writers' audit contract.
 *
 * An entry names the entry point that ran the shared helper, not the helper: `syncIssue` and the
 * PR-state write are called by a REST route, the poller and the webhook intake alike, so the caller
 * passes its own key. The inventory rows of `permissions-p2-audit-coverage` are per entry point, which
 * is what lets its walker match these entries.
 */

/** The key an issue import records: the entry point that ran syncIssue. */
export type VcsIssueAuditKey = 'vcs.sync.issue' | 'vcs.sync.all' | 'system.vcs.poll-issues' | 'system.vcs.webhook-intake';

/** The key a PR-state write records: the entry point that saw the state. */
export type VcsPrStateAuditKey = 'vcs.sync.pr' | 'system.vcs.poll-issues' | 'system.vcs.webhook-intake';

/** `pr <before> -> <after>`; `before` is `none` for a link with no stored state. */
export function prStateSummary(before: string | null, after: string): string {
  return `pr ${before ?? 'none'} -> ${after}`;
}
