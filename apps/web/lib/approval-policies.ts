/**
 * P3b US-008: the approval-policy pages' pure half.
 *
 * A policy says who must approve one permission key before the action runs. The three policy pages
 * (global here, project in US-009) share one dialog, one list and one composable, so every rule that
 * can be decided without a component lives here: which keys a pattern covers, the floor that follows
 * from them, the modes the form may offer, how many policies already override a key, and the exact
 * bodies the API takes.
 *
 * The API is the authority. `apps/api/src/approvals/approval-policy.validation.ts` refuses a pattern
 * that covers no approvable key, a mode below the covered keys' floor, a timeout outside 60 s … 30
 * days and an approve-on-timeout above a `none` floor. What this module adds is a form that cannot
 * offer those values in the first place, and a dialog that toasts whatever the API still refuses.
 */
import * as z from 'zod'
import { apiPath } from '~/lib/api-path'
import type { ApprovalMode } from '~/lib/approval-requests'
import type { TranslateNamed } from '~/lib/fleet-budgets'

export type { ApprovalMode }

/** Which route prefix a policy page talks to: the global routes, or one project's. */
export type PolicyBase = { kind: 'global' } | { kind: 'project'; slug: string }

/** Modes rank `none < self < agent < human` (approval-policy.validation.ts). */
export const APPROVAL_MODES: readonly ApprovalMode[] = ['none', 'self', 'agent', 'human']

/** The ranking `strictestMode` uses on the server, so the two agree on what "below the floor" is. */
const MODE_RANK: Record<ApprovalMode, number> = { none: 0, self: 1, agent: 2, human: 3 }

/** apps/api `ApprovalSubjectType`: who a `type` subject names. */
export const PRINCIPAL_TYPES = ['USER', 'AGENT', 'ASSISTANT'] as const
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number]

/** `ApprovableKeyDto`: one key the engine can hold for approval, with its floor and default. */
export interface ApprovableKey {
  key: string
  scope: 'global' | 'project' | 'any'
  risk: 'low' | 'medium' | 'high' | 'critical'
  floor: ApprovalMode
  default: ApprovalMode
}

/** `ApprovalPolicyDto`: one stored policy. */
export interface ApprovalPolicy {
  id: string
  /** `<projectId|*>|<permissionPattern>|<subject>`; the pattern and subject are part of it. */
  selector: string
  projectId: string | null
  permissionPattern: string
  principalType: PrincipalType | null
  roleId: string | null
  principalId: string | null
  mode: ApprovalMode
  timeoutSec: number | null
  onTimeout: 'reject' | 'approve'
  requiredApprovals: number
  approverMustHoldAction: boolean
  requireDistinctApprover: boolean
  updatedByType: string
  updatedById: string
  createdAt: string
  updatedAt: string
}

/** One page of `GET /approval-policies`, as the API envelopes it. */
export interface ApprovalPolicyPage {
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
  records: ApprovalPolicy[]
}

/** The five fields an edit may change: the pattern and the subject are part of the selector. */
export interface PolicyFormValues {
  mode: ApprovalMode
  /** The form's text; a blank value means "no timeout" (the patch sends `null`). */
  timeoutSec: string | number
  onTimeout: 'reject' | 'approve'
  approverMustHoldAction: boolean
  requireDistinctApprover: boolean
}

/** What the dialog may create: `all`, `type` and `role` (a single principal is out of scope). */
export type PolicySubjectInput =
  | { kind: 'all' }
  | { kind: 'type'; principalType: PrincipalType }
  | { kind: 'role'; roleId: string }

/** The policy's stored subject, read back for display (a `principal` subject only ever lists). */
export type PolicySubject =
  | { kind: 'all' }
  | { kind: 'type'; principalType: PrincipalType }
  | { kind: 'role'; roleId: string }
  | { kind: 'principal'; principalType: PrincipalType; principalId: string }

/** apps/api `MIN_APPROVAL_TIMEOUT_SEC` / `MAX_APPROVAL_TIMEOUT_SEC`. */
export const MIN_POLICY_TIMEOUT_SEC = 60
export const MAX_POLICY_TIMEOUT_SEC = 2_592_000

const PREFIX_WILDCARD = '.*'

/** The global or project route prefix of one base. */
export function policyRoot(base: PolicyBase): string {
  return base.kind === 'global' ? '/approval-policies' : apiPath`/projects/${base.slug}/approval-policies`
}

/** One policy's route: `PATCH` and `DELETE` take it. */
export function policyItem(base: PolicyBase, id: string): string {
  return base.kind === 'global'
    ? apiPath`/approval-policies/${id}`
    : apiPath`/projects/${base.slug}/approval-policies/${id}`
}

/** `GET <root>/keys`: the approvable keys, their floors and their defaults. */
export function policyKeysPath(base: PolicyBase): string {
  return `${policyRoot(base)}/keys`
}

/**
 * Does `pattern` cover `key`? An exact pattern covers only its own key; a `<prefix>.*` pattern covers
 * the keys under `<prefix>.` — the dot included, exactly as the API's `approvableEntriesFor` matches.
 */
export function patternCovers(pattern: string, key: string): boolean {
  const trimmed = pattern.trim()
  if (trimmed === '') return false
  if (trimmed === key) return true
  if (!trimmed.endsWith(PREFIX_WILDCARD)) return false
  return key.startsWith(`${trimmed.slice(0, -PREFIX_WILDCARD.length)}.`)
}

/** The approvable keys one pattern covers. */
export function keysUnder(pattern: string, keys: readonly ApprovableKey[]): ApprovableKey[] {
  return keys.filter((entry) => patternCovers(pattern, entry.key))
}

/**
 * The strictest floor among the keys `pattern` covers, or `null` when it covers none — which is the
 * one case the API refuses outright, so the dialog refuses it too (the pattern message, Save disabled).
 */
export function patternFloor(pattern: string, keys: readonly ApprovableKey[]): ApprovalMode | null {
  const covered = keysUnder(pattern, keys)
  if (covered.length === 0) return null
  return covered.reduce<ApprovalMode>(
    (strictest, entry) => (MODE_RANK[entry.floor] > MODE_RANK[strictest] ? entry.floor : strictest),
    'none',
  )
}

/**
 * The modes a form may offer for a floor: the floor itself and everything stricter. A null floor (a
 * pattern covering nothing) offers nothing, because no mode would be acceptable.
 */
export function modeOptions(floor: ApprovalMode | null): ApprovalMode[] {
  if (floor === null) return []
  return APPROVAL_MODES.filter((mode) => MODE_RANK[mode] >= MODE_RANK[floor])
}

/**
 * How many of `policies` override one key: those whose pattern is the key itself or a prefix wildcard
 * above it. Counted over every loaded policy page, which is why the list reads them all.
 */
export function overrideCount(key: string, policies: readonly Pick<ApprovalPolicy, 'permissionPattern'>[]): number {
  return policies.filter((policy) => patternCovers(policy.permissionPattern, key)).length
}

/** The stored subject of one policy. */
export function policySubject(policy: Pick<ApprovalPolicy, 'principalType' | 'roleId' | 'principalId'>): PolicySubject {
  if (policy.roleId !== null) return { kind: 'role', roleId: policy.roleId }
  if (policy.principalId !== null && policy.principalType !== null) {
    return { kind: 'principal', principalType: policy.principalType, principalId: policy.principalId }
  }
  if (policy.principalType !== null) return { kind: 'type', principalType: policy.principalType }
  return { kind: 'all' }
}

/** One policy's subject as the list shows it. */
export function policySubjectText(t: TranslateNamed, policy: Pick<ApprovalPolicy, 'principalType' | 'roleId' | 'principalId'>): string {
  const subject = policySubject(policy)
  switch (subject.kind) {
    case 'all': return t('approvals.policies.subject.all')
    case 'type':
      return t('approvals.policies.subject.type', { type: t(`approvals.policies.principal.${subject.principalType}`) })
    case 'role': return t('approvals.policies.subject.role', { role: subject.roleId })
    case 'principal':
      return t('approvals.policies.subject.principal', {
        type: t(`approvals.policies.principal.${subject.principalType}`),
        principal: subject.principalId,
      })
  }
}

/**
 * The timeout the form text stands for: `null` when it is blank (no timeout), else the number. The
 * patch sends that `null` explicitly, because clearing a stored timeout has to reach the API.
 */
export function parseTimeout(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

/** The form values one dialog opens with: the stored policy's, or a create form's defaults. */
export function initialPolicyValues(policy: ApprovalPolicy | null): PolicyFormValues {
  return {
    // `human` is the strictest mode, so it is valid for every floor a new pattern can have.
    mode: policy?.mode ?? 'human',
    timeoutSec: policy?.timeoutSec === null || policy?.timeoutSec === undefined ? '' : String(policy.timeoutSec),
    onTimeout: policy?.onTimeout ?? 'reject',
    approverMustHoldAction: policy?.approverMustHoldAction ?? false,
    requireDistinctApprover: policy?.requireDistinctApprover ?? false,
  }
}

/**
 * The dialog's schema (`web.md`: schema-backed forms). It refuses what the API refuses and words it
 * in the caller's locale: a timeout outside the API's bounds, an approve-on-timeout above a `none`
 * floor (which would silently approve a critical action), and a mode below the floor.
 */
export function buildPolicySchema(t: TranslateNamed, floor: ApprovalMode | null) {
  return z.object({
    mode: z.enum(['none', 'self', 'agent', 'human']).superRefine((value, ctx) => {
      if (floor !== null && MODE_RANK[value] < MODE_RANK[floor]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('approvals.policies.validation.mode') })
      }
    }),
    // The form binds a text input, so the value is a string; a caller may hand over a number instead.
    timeoutSec: z.union([z.string(), z.number()]).superRefine((value, ctx) => {
      const text = typeof value === 'number' ? String(value) : value.trim()
      if (text === '') return
      if (!/^\d+$/.test(text) || Number(text) < MIN_POLICY_TIMEOUT_SEC || Number(text) > MAX_POLICY_TIMEOUT_SEC) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('approvals.policies.validation.timeout') })
      }
    }),
    onTimeout: z.enum(['reject', 'approve']).superRefine((value, ctx) => {
      if (value === 'approve' && floor !== null && floor !== 'none') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: t('approvals.policies.validation.timeoutApprove') })
      }
    }),
    approverMustHoldAction: z.boolean(),
    requireDistinctApprover: z.boolean(),
  })
}

/**
 * The create body. It carries the selector, the mode and the on-timeout choice, and only then the
 * optional fields the caller actually set: an untouched control must not send a default the API
 * would then store as if the admin had chosen it.
 */
export function toCreateBody(
  pattern: string,
  appliesTo: PolicySubjectInput,
  values: PolicyFormValues,
): Record<string, unknown> {
  const timeout = parseTimeout(values.timeoutSec)
  return {
    permissionPattern: pattern.trim(),
    appliesTo: { ...appliesTo },
    mode: values.mode,
    onTimeout: values.onTimeout,
    ...(timeout === null ? {} : { timeoutSec: timeout }),
    ...(values.approverMustHoldAction ? { approverMustHoldAction: true } : {}),
    ...(values.requireDistinctApprover ? { requireDistinctApprover: true } : {}),
  }
}

/**
 * The patch body: exactly the five mutable fields. `PATCH` does not accept the pattern, the subject
 * or the quorum, so an edit cannot move a policy to another selector by accident — and a cleared
 * timeout travels as `null`, which is what the API reads as "no timeout".
 */
export function toPatchBody(values: PolicyFormValues): Record<string, unknown> {
  return {
    mode: values.mode,
    timeoutSec: parseTimeout(values.timeoutSec),
    onTimeout: values.onTimeout,
    approverMustHoldAction: values.approverMustHoldAction === true,
    requireDistinctApprover: values.requireDistinctApprover === true,
  }
}
