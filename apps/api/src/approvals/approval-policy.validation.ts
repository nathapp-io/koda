/**
 * Permissions P3a US-004: approval-policy validation and its selector.
 *
 * A policy says who must approve an action before it runs, so the validator refuses a policy that
 * could never resolve to anything meaningful: a pattern naming no approvable catalog key, a subject
 * with no principal, an unknown mode, a mode weaker than the floor of the keys the pattern covers,
 * a timeout outside 60 s … 30 days, an approve-on-timeout above a `none` floor (silently approving a
 * critical action), and a quorum the engine does not count.
 *
 * Pure: no repository, no clock, no throwing. `ApprovalPolicyService` (US-005) throws
 * `InvalidApprovalPolicyError(violation)` for the violation returned here, and persists the selector.
 */
import { findCatalogEntry, PERMISSION_CATALOG } from '../permissions/catalog';
import type { PermissionCatalogEntry } from '../permissions/catalog';
import { APPROVAL_MODE_RANK, strictestMode } from './domain/approval-mode';
import type { ApprovalPolicyInput, ApprovalPolicyViolation } from './domain/approval.domain';

/** The shortest policy timeout: a minute. */
export const MIN_APPROVAL_TIMEOUT_SEC = 60;
/** The longest policy timeout: thirty days. */
export const MAX_APPROVAL_TIMEOUT_SEC = 2_592_000;

const PREFIX_WILDCARD_SUFFIX = '.*';
const MODES: readonly string[] = ['none', 'self', 'agent', 'human'];

/**
 * Every approvable catalog key the pattern names: the exact key, or — for `<prefix>.*` — the
 * approvable keys under `<prefix>.`, the dot included, exactly as `findCandidates` matches a query
 * key, so a policy's floor covers the same keys its pattern can resolve for.
 */
function approvableEntriesFor(pattern: string): PermissionCatalogEntry[] {
  if (pattern.endsWith(PREFIX_WILDCARD_SUFFIX)) {
    const prefix = `${pattern.slice(0, -PREFIX_WILDCARD_SUFFIX.length)}.`;
    return PERMISSION_CATALOG.filter((entry) => entry.approval.approvable && entry.key.startsWith(prefix));
  }
  const entry = findCatalogEntry(pattern);
  return entry !== undefined && entry.approval.approvable ? [entry] : [];
}

/** The first violation of `input`, or null. Defaults: no timeout, reject, one approval. */
export function validateApprovalPolicy(input: ApprovalPolicyInput): ApprovalPolicyViolation | null {
  const entries = approvableEntriesFor(input.permissionPattern);
  if (entries.length === 0) return 'pattern';

  const { appliesTo } = input;
  if (appliesTo.kind === 'principal' && appliesTo.principalId.trim() === '') return 'subject';
  if (appliesTo.kind === 'role' && appliesTo.roleId.trim() === '') return 'subject';

  if (!MODES.includes(input.mode)) return 'mode';

  const floor = strictestMode(...entries.map((entry) => entry.approval.floor));
  if (APPROVAL_MODE_RANK[input.mode] < APPROVAL_MODE_RANK[floor]) return 'below-floor';

  const { timeoutSec = null, onTimeout = 'reject', requiredApprovals = 1 } = input;
  if (timeoutSec !== null && !isValidTimeout(timeoutSec)) return 'timeout';

  if (onTimeout === 'approve' && floor !== 'none') return 'timeout-approve';

  if (requiredApprovals !== 1) return 'required-approvals';

  return null;
}

function isValidTimeout(timeoutSec: number): boolean {
  return Number.isInteger(timeoutSec) && timeoutSec >= MIN_APPROVAL_TIMEOUT_SEC &&
    timeoutSec <= MAX_APPROVAL_TIMEOUT_SEC;
}

/**
 * "<projectId|*>|<permissionPattern>|<subject>", the unique `ApprovalPolicy.selector` of the input:
 * subject is `all`, `type:<USER|AGENT|ASSISTANT>`, `role:<roleId>` or `principal:<USER|AGENT>:<id>`.
 */
export function policySelector(
  input: Pick<ApprovalPolicyInput, 'projectId' | 'permissionPattern' | 'appliesTo'>,
): string {
  return `${input.projectId ?? '*'}|${input.permissionPattern}|${subjectSelector(input.appliesTo)}`;
}

function subjectSelector(appliesTo: ApprovalPolicyInput['appliesTo']): string {
  switch (appliesTo.kind) {
    case 'all': return 'all';
    case 'type': return `type:${appliesTo.principalType}`;
    case 'role': return `role:${appliesTo.roleId}`;
    case 'principal': return `principal:${appliesTo.principalType}:${appliesTo.principalId}`;
  }
}
