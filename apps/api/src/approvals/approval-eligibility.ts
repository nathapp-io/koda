/**
 * P3 approval core (US-006): who may decide a request.
 *
 * Pure and ordered. The first refusal wins, so a decider that is not a principal, is the actor of
 * a request that requires a distinct approver, does not hold the action, does not hold the decide
 * permission or cannot contribute a high enough tier is refused for that reason only.
 *
 * Approving and rejecting share this rule: whoever could not approve a request cannot reject it
 * either. A refusal is `EligibilityRefusal`; `assistant-cannot-decide` is never returned here (step
 * 1 already refuses every `SYSTEM` decider) and is kept in the type for the API error mapping.
 */
import type { ApprovalMode } from '../permissions/catalog';
import type { ApprovalRequestRecord, EligibilityRefusal } from './domain/approval.domain';
import { modeAtLeast } from './domain/approval-mode';

export interface DeciderRef {
  type: 'USER' | 'AGENT' | 'SYSTEM' | 'RUNNER';
  id: string;
}

export type Eligibility = { ok: true; satisfiedBy: ApprovalMode } | { ok: false; reason: EligibilityRefusal };

type ApprovalRequestRef = Pick<
  ApprovalRequestRecord,
  'permissionKey' | 'actor' | 'onBehalfOf' | 'requiredMode' | 'approverMustHoldAction' | 'requireDistinctApprover'
>;

interface PrincipalKind {
  type: string;
  id: string;
}

/** The thread assistant acts as `SYSTEM/assistant` on behalf of a user (P3 design §4). */
const ASSISTANT: PrincipalKind = { type: 'SYSTEM', id: 'assistant' };
const OWN_SUFFIX = '.own';
const DECIDE_KEY = 'approval.decide';
const DECIDE_PATTERN_PREFIX = 'approval.decide@';
const ANY_SUFFIX = '.*';

function refuse(reason: EligibilityRefusal): Eligibility {
  return { ok: false, reason };
}

function isSamePrincipal(one: PrincipalKind, other: PrincipalKind | null): boolean {
  return other !== null && one.type === other.type && one.id === other.id;
}

/** The mode the decider itself contributes to the ladder. */
function contributedMode(decider: DeciderRef, isActor: boolean, isOnBehalf: boolean): ApprovalMode {
  if (isActor) return 'self';
  if (isOnBehalf) return 'human';
  return decider.type === 'USER' ? 'human' : 'agent';
}

/**
 * The action is held by its plain key. `X.own` only covers rows the holder created, so it counts
 * for the request's own actor (and the user it was made on behalf of) and for nobody else.
 */
function holdsAction(deciderKeys: ReadonlySet<string>, permissionKey: string, isOwnRequest: boolean): boolean {
  if (deciderKeys.has(permissionKey)) return true;
  return isOwnRequest && deciderKeys.has(`${permissionKey}${OWN_SUFFIX}`);
}

/** `approval.decide@<pattern>`: the key itself, or a `<prefix>.*` the key falls under. */
export function matchesDecidePattern(pattern: string, permissionKey: string): boolean {
  if (pattern === permissionKey) return true;
  if (!pattern.endsWith(ANY_SUFFIX)) return false;
  return permissionKey.startsWith(`${pattern.slice(0, -ANY_SUFFIX.length)}.`);
}

function holdsDecide(deciderKeys: ReadonlySet<string>, permissionKey: string): boolean {
  if (deciderKeys.has(DECIDE_KEY)) return true;
  for (const entry of deciderKeys) {
    if (entry.startsWith(DECIDE_PATTERN_PREFIX)
      && matchesDecidePattern(entry.slice(DECIDE_PATTERN_PREFIX.length), permissionKey)) return true;
  }
  return false;
}

export function decideEligibility(
  request: ApprovalRequestRef,
  decider: DeciderRef,
  deciderKeys: ReadonlySet<string>,
): Eligibility {
  if (decider.type === 'SYSTEM' || decider.type === 'RUNNER') return refuse('not-a-principal');

  const isActor = isSamePrincipal(decider, request.actor);
  const isOnBehalf = isSamePrincipal(request.actor, ASSISTANT)
    && isSamePrincipal(decider, request.onBehalfOf);

  if (request.requireDistinctApprover && isActor) return refuse('distinct-approver-required');

  const isOwnRequest = isActor || isOnBehalf;
  if ((isOwnRequest || request.approverMustHoldAction)
    && !holdsAction(deciderKeys, request.permissionKey, isOwnRequest)) {
    return refuse('missing-action-permission');
  }

  if (!isOwnRequest && !holdsDecide(deciderKeys, request.permissionKey)) {
    return refuse('missing-decide-permission');
  }

  const contributed = contributedMode(decider, isActor, isOnBehalf);
  if (!modeAtLeast(contributed, request.requiredMode)) return refuse('tier-too-low');

  return { ok: true, satisfiedBy: contributed };
}
