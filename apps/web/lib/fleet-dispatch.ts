import * as z from 'zod'
import type { BashMode, DispatchBody } from '~/lib/fleet-types'
import { BASH_MODES, bashCreateFields, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid, minutesText } from '~/lib/fleet-bash-mode'
import { LABEL_PATTERN } from '~/lib/fleet-validation'
import { MAX_DISPATCH_TICKETS, TICKET_REF_RE, ticketRefsFromQuery } from '~/lib/fleet-ticket-links'

/** apps/api/src/fleet/jobs/dispatch-input.ts FEATURE_RE (nax validateFeatureName). */
export const FEATURE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
/** apps/api/src/fleet/common/capabilities.ts PROFILE_NAME_RE. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
export const RESERVED_PROFILE_PREFIX = 'koda-job-'
export const MAX_PROFILES = 8
/** DispatchFleetJobDto selectorLabels max (a runner's own labels allow 20: 4b's MAX_LABELS). */
export const MAX_SELECTOR_LABELS = 16
export const MAX_COST_USD = 10_000

type Translate = (key: string) => string

/**
 * The dispatch form (S1 spec §5.1). Mirrors the server's checks so most mistakes are caught
 * before the request; the server stays the authority (its 400 message is shown as-is).
 */
export function buildDispatchSchema(t: Translate) {
  return z.object({
    repoId: z.string({ required_error: t('fleet.dispatch.validation.repoRequired') }).min(1, t('fleet.dispatch.validation.repoRequired')),
    ref: z.string().optional(),
    command: z.enum(['RUN', 'PLAN', 'REVIEW', 'FIX']),
    feature: z.string(),
    prNumber: z.string().optional(),
    planFrom: z.string().optional(),
    profiles: z.array(z.string()).max(MAX_PROFILES, t('fleet.dispatch.validation.profilesMax'))
      .refine(list => list.every(p => PROFILE_NAME_RE.test(p) && !p.startsWith(RESERVED_PROFILE_PREFIX)), t('fleet.dispatch.validation.profileName'))
      .refine(list => new Set(list).size === list.length, t('fleet.dispatch.validation.profileDuplicate')),
    maxCostUsd: z.coerce.number({ invalid_type_error: t('fleet.dispatch.validation.maxCost') })
      .gt(0, t('fleet.dispatch.validation.maxCost'))
      .max(MAX_COST_USD, t('fleet.dispatch.validation.maxCost'))
      .refine(n => Math.abs(n * 10_000 - Math.round(n * 10_000)) < 1e-6, t('fleet.dispatch.validation.maxCost')), // at most 4 decimals
    selectorLabels: z.array(z.string()).max(MAX_SELECTOR_LABELS, t('fleet.dispatch.validation.labelsMax'))
      .refine(list => list.every(l => LABEL_PATTERN.test(l)), t('fleet.dispatch.validation.label')),
    pinnedRunnerId: z.string().optional(),
    ticketRefs: z.array(z.string()),
    bashMode: z.string(),
    /** Under v-if: may be undefined when unmounted (the D182 trap). */
    approvalTimeoutMinutes: z.string().optional(),
  }).superRefine((v, ctx) => {
    const runOrPlan = v.command === 'RUN' || v.command === 'PLAN'
    if (runOrPlan) {
      const issue = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: t(message) })
      if (!FEATURE_RE.test(v.feature) || v.feature.includes('..')) issue('feature', 'fleet.dispatch.validation.feature')
      if (v.ref !== undefined && v.ref.length > 255) issue('ref', 'fleet.dispatch.validation.ref')
      if (v.planFrom !== undefined && v.planFrom.length > 512) issue('planFrom', 'fleet.dispatch.validation.planFrom')
      if (v.ticketRefs.length > MAX_DISPATCH_TICKETS || !v.ticketRefs.every(ref => TICKET_REF_RE.test(ref))) {
        issue('ticketRefs', 'fleet.dispatch.validation.tickets')
      }
      if (!BASH_MODES.includes(v.bashMode as (typeof BASH_MODES)[number])) issue('bashMode', 'fleet.dispatch.validation.bashMode')
    }
    if (v.command === 'REVIEW' || v.command === 'FIX') {
      const prNumber = (v.prNumber ?? '').trim()
      if (!/^[1-9][0-9]*$/.test(prNumber) || Number(prNumber) > 2_147_483_647) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prNumber'], message: t('fleet.dispatch.validation.prNumber') })
      }
    }
    if (v.command === 'PLAN' && !(v.planFrom ?? '').trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planFrom'], message: t('fleet.dispatch.validation.planFromRequired') })
    }
    if (v.pinnedRunnerId && v.selectorLabels.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectorLabels'], message: t('fleet.dispatch.validation.labelsOrPin') })
    }
    if (v.command === 'RUN' && !isBashTimeoutValid(v.bashMode as BashMode, v.approvalTimeoutMinutes ?? '')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['approvalTimeoutMinutes'], message: t('fleet.bash.validation.timeout') })
    }
  })
}

export type DispatchFormValues = z.infer<ReturnType<typeof buildDispatchSchema>>

export const DISPATCH_DEFAULTS: DispatchFormValues = {
  repoId: '',
  ref: '',
  command: 'RUN',
  feature: '',
  prNumber: '',
  planFrom: '',
  profiles: [],
  maxCostUsd: 5,
  selectorLabels: [],
  pinnedRunnerId: '',
  ticketRefs: [],
  bashMode: 'raw',
  approvalTimeoutMinutes: minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC),
}

/** Form values -> request body: trims, drops empty optionals, planFrom only for PLAN, bash fields only for a gated/escalate RUN (D299). */
export function toDispatchBody(v: DispatchFormValues, opts: { acknowledgeOpenPr?: boolean } = {}): DispatchBody {
  const ref = (v.ref ?? '').trim()
  const planFrom = (v.planFrom ?? '').trim()
  const pin = (v.pinnedRunnerId ?? '').trim()
  if (v.command === 'REVIEW' || v.command === 'FIX') {
    return {
      repoId: v.repoId,
      command: v.command,
      prNumber: Number((v.prNumber ?? '').trim()),
      maxCostUsd: v.maxCostUsd,
      ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
      ...(pin ? { pinnedRunnerId: pin } : v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
    }
  }
  return {
    repoId: v.repoId,
    command: v.command,
    feature: v.feature.trim(),
    maxCostUsd: v.maxCostUsd,
    ...(ref ? { ref } : {}),
    ...(v.command === 'PLAN' && planFrom ? { planFrom } : {}),
    ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
    ...(pin ? { pinnedRunnerId: pin } : v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
    ...(v.ticketRefs.length > 0 ? { ticketRefs: [...v.ticketRefs] } : {}),
    ...(v.command === 'RUN' ? bashCreateFields(v.bashMode as BashMode, v.approvalTimeoutMinutes ?? '') : {}),
    ...(opts.acknowledgeOpenPr ? { acknowledgeOpenPr: true } : {}),
  }
}

/** Query prefill for the dispatch form (PLAN -> RUN handoff, Admin Repos link). Only known-good values pass. */
export interface DispatchQuery {
  readonly command?: unknown
  readonly repoId?: unknown
  readonly feature?: unknown
  readonly ref?: unknown
  readonly tickets?: unknown
}

const singleText = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null

export function dispatchPrefillFromQuery(query?: DispatchQuery | null): Partial<DispatchFormValues> {
  const prefill: Partial<DispatchFormValues> = {}
  if (!query) return prefill
  const command = singleText(query.command)
  if (command === 'RUN' || command === 'PLAN') prefill.command = command
  const repoId = singleText(query.repoId)?.trim()
  if (repoId) prefill.repoId = repoId
  const feature = singleText(query.feature)?.trim()
  if (feature && FEATURE_RE.test(feature) && !feature.includes('..')) prefill.feature = feature
  const ref = singleText(query.ref)
  if (ref && ref.trim() && ref.length <= 255) prefill.ref = ref.trim()
  const ticketRefs = ticketRefsFromQuery(query.tickets)
  if (ticketRefs.length > 0) prefill.ticketRefs = ticketRefs
  return prefill
}

/** P7: the notice a prefilled form shows: from a ticket (tickets, no ref), else from a PLAN job or an admin link. */
export function prefillNotice(prefill: Partial<DispatchFormValues>): 'ticket' | 'plan' | null {
  if (Object.keys(prefill).length === 0) return null
  return prefill.ticketRefs !== undefined && prefill.ref === undefined ? 'ticket' : 'plan'
}

/** Adds a token to a chain once, trimmed; the list is never mutated. */
export function addToken(list: readonly string[], token: string): string[] {
  const value = token.trim()
  if (!value || list.includes(value)) return [...list]
  return [...list, value]
}

export const removeToken = (list: readonly string[], token: string): string[] => list.filter(item => item !== token)
