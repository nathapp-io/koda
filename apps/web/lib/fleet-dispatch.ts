import * as z from 'zod'
import type { DispatchBody } from '~/lib/fleet-types'
import { LABEL_PATTERN } from '~/lib/fleet-validation'

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
    ref: z.string().max(255, t('fleet.dispatch.validation.ref')).optional(),
    command: z.enum(['RUN', 'PLAN']),
    feature: z.string()
      .regex(FEATURE_RE, t('fleet.dispatch.validation.feature'))
      .refine(value => !value.includes('..'), t('fleet.dispatch.validation.feature')),
    planFrom: z.string().max(512, t('fleet.dispatch.validation.planFrom')).optional(),
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
  }).superRefine((v, ctx) => {
    if (v.command === 'PLAN' && !(v.planFrom ?? '').trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['planFrom'], message: t('fleet.dispatch.validation.planFromRequired') })
    }
    if (v.pinnedRunnerId && v.selectorLabels.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['selectorLabels'], message: t('fleet.dispatch.validation.labelsOrPin') })
    }
  })
}

export type DispatchFormValues = z.infer<ReturnType<typeof buildDispatchSchema>>

export const DISPATCH_DEFAULTS: DispatchFormValues = {
  repoId: '',
  ref: '',
  command: 'RUN',
  feature: '',
  planFrom: '',
  profiles: [],
  maxCostUsd: 5,
  selectorLabels: [],
  pinnedRunnerId: '',
}

/** Form values -> request body: trims, drops empty optionals, planFrom only for PLAN. */
export function toDispatchBody(v: DispatchFormValues): DispatchBody {
  const ref = (v.ref ?? '').trim()
  const planFrom = (v.planFrom ?? '').trim()
  const pin = (v.pinnedRunnerId ?? '').trim()
  return {
    repoId: v.repoId,
    command: v.command,
    feature: v.feature.trim(),
    maxCostUsd: v.maxCostUsd,
    ...(ref ? { ref } : {}),
    ...(v.command === 'PLAN' && planFrom ? { planFrom } : {}),
    ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
    ...(pin ? { pinnedRunnerId: pin } : v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
  }
}

/** Adds a token to a chain once, trimmed; the list is never mutated. */
export function addToken(list: readonly string[], token: string): string[] {
  const value = token.trim()
  if (!value || list.includes(value)) return [...list]
  return [...list, value]
}

export const removeToken = (list: readonly string[], token: string): string[] => list.filter(item => item !== token)
