import * as z from 'zod'
import { budgetStopPolicyId, toUnits, trimDecimal } from '~/lib/fleet-budgets'
import type { TranslateNamed } from '~/lib/fleet-budgets'
import {
  FEATURE_RE, MAX_COST_USD, MAX_PROFILES, MAX_SELECTOR_LABELS, PROFILE_NAME_RE, RESERVED_PROFILE_PREFIX,
} from '~/lib/fleet-dispatch'
import { extractProgress, formatUsd, wipPushStatus } from '~/lib/fleet-jobs'
import type { WipPushStatus } from '~/lib/fleet-jobs'
import { LABEL_PATTERN } from '~/lib/fleet-validation'
import { BASH_MODES, bashCreateFields, bashPatchFields, DEFAULT_APPROVAL_TIMEOUT_SEC, isBashTimeoutValid, minutesText } from '~/lib/fleet-bash-mode'
import type { BashMode, FleetJobDto, NewScheduleBody, ScheduleDisabledReason, ScheduleDto, SchedulePatchBody } from '~/lib/fleet-types'

/** CreateScheduleDto limits (apps/api/src/fleet/schedules/dto). */
export const MAX_NAME_LENGTH = 80
export const MAX_REF_LENGTH = 255
export const MAX_NO_PROGRESS_LIMIT = 20
export const DEFAULT_NO_PROGRESS_LIMIT = 3
const DEFAULT_MAX_COST = '5'
const UNITS_PER_USD = 10_000

export const PLACEMENT_MODES = ['auto', 'labels', 'pin'] as const
export type PlacementMode = (typeof PLACEMENT_MODES)[number]
export type ScheduleFormMode = 'create' | 'edit'

/** Form values are strings and lists; numbers are parsed on submit (D219). */
export interface ScheduleFormValues {
  name: string
  repoId: string
  feature: string
  cron: string
  timezone: string
  ref: string
  profiles: string[]
  maxCostUsd: string
  placement: PlacementMode
  selectorLabels: string[]
  pinnedRunnerId: string
  noProgressLimit: string
  bashMode: BashMode
  approvalTimeoutMinutes: string
}

const cronFields = (input: string): string[] => input.trim().split(/\s+/).filter((field) => field !== '')

/** Exactly five fields; syntax and the 15-minute gap are the server's (D219). */
export const isCronShape = (input: string): boolean => cronFields(input).length === 5

export const normalizeCron = (input: string): string => cronFields(input).join(' ')

/** An IANA zone the runtime knows; fixed offsets (`+08:00`) are refused, as the server does (3a D191). */
export function isAcceptedTimeZone(input: string): boolean {
  const zone = input.trim()
  if (zone === '' || /^[+-]/.test(zone)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0)
    return true
  }
  catch {
    return false
  }
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }
  catch {
    return 'UTC'
  }
}

/** Suggestions for the timezone input; empty where the runtime cannot list zones. */
export function timeZoneOptions(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? []
  }
  catch {
    return []
  }
}

const COST_RE = /^\d{1,5}(?:\.\d{1,4})?$/

/** Budget of each run: > 0, at most 4 decimals, at most MAX_COST_USD, compared in ten-thousandths (no floats). */
export function parseMaxCost(input: string): number | null {
  const trimmed = input.trim()
  if (!COST_RE.test(trimmed)) return null
  const units = toUnits(trimmed)
  if (units === null || units <= BigInt(0) || units > BigInt(MAX_COST_USD) * BigInt(UNITS_PER_USD)) return null
  return Number(trimmed)
}

export function parseNoProgressLimit(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d{1,2}$/.test(trimmed)) return null
  const value = Number(trimmed)
  return value >= 1 && value <= MAX_NO_PROGRESS_LIMIT ? value : null
}

const text = z.string().default('')
const list = z.array(z.string()).default([])

/** The create/edit form (D218, D219). Fields under v-if are tolerant of undefined (the D182 trap). */
export function buildScheduleSchema(t: TranslateNamed, mode: ScheduleFormMode) {
  return z.object({
    name: z.string().refine((v) => v.trim().length >= 1 && v.trim().length <= MAX_NAME_LENGTH, t('fleet.schedules.validation.name')),
    repoId: text,
    feature: text,
    cron: z.string().refine(isCronShape, t('fleet.schedules.validation.cron')),
    timezone: z.string().refine(isAcceptedTimeZone, t('fleet.schedules.validation.timezone')),
    ref: text.refine((v) => v.trim().length <= MAX_REF_LENGTH, t('fleet.schedules.validation.ref')),
    profiles: list
      .refine((l) => l.length <= MAX_PROFILES, t('fleet.schedules.validation.profiles'))
      .refine((l) => l.every((p) => PROFILE_NAME_RE.test(p) && !p.startsWith(RESERVED_PROFILE_PREFIX)), t('fleet.schedules.validation.profiles'))
      .refine((l) => new Set(l).size === l.length, t('fleet.schedules.validation.profiles')),
    maxCostUsd: z.string().refine((v) => parseMaxCost(v) !== null, t('fleet.schedules.validation.maxCost')),
    placement: z.enum(PLACEMENT_MODES),
    selectorLabels: list
      .refine((l) => l.length <= MAX_SELECTOR_LABELS, t('fleet.schedules.validation.labels'))
      .refine((l) => l.every((label) => LABEL_PATTERN.test(label)), t('fleet.schedules.validation.labels')),
    pinnedRunnerId: text,
    noProgressLimit: z.string().refine((v) => parseNoProgressLimit(v) !== null, t('fleet.schedules.validation.noProgressLimit')),
    bashMode: z.enum(BASH_MODES).default('raw'),
    approvalTimeoutMinutes: text,
  }).superRefine((v, ctx) => {
    const issue = (path: string, key: string): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: t(key) })
    }
    if (mode === 'create') {
      if (v.repoId.trim() === '') issue('repoId', 'fleet.schedules.validation.repoRequired')
      const feature = v.feature.trim()
      if (!FEATURE_RE.test(feature) || feature.includes('..')) issue('feature', 'fleet.schedules.validation.feature')
    }
    if (mode === 'edit' && v.ref.trim() === '') issue('ref', 'fleet.schedules.validation.refRequired')
    if (v.placement === 'pin' && v.pinnedRunnerId.trim() === '') issue('pinnedRunnerId', 'fleet.schedules.validation.pinRequired')
    if (v.placement === 'labels' && v.selectorLabels.length === 0) issue('selectorLabels', 'fleet.schedules.validation.labelsRequired')
    if (!isBashTimeoutValid(v.bashMode, v.approvalTimeoutMinutes)) issue('approvalTimeoutMinutes', 'fleet.bash.validation.timeout')
  })
}

export const placementOf = (s: Pick<ScheduleDto, 'pinnedRunnerId' | 'selectorLabels'>): PlacementMode =>
  s.pinnedRunnerId ? 'pin' : s.selectorLabels.length > 0 ? 'labels' : 'auto'

export function initialScheduleValues(s: ScheduleDto | null, timezone: string): ScheduleFormValues {
  if (s === null) {
    return {
      name: '', repoId: '', feature: '', cron: '', timezone, ref: '', profiles: [], maxCostUsd: DEFAULT_MAX_COST,
      placement: 'auto', selectorLabels: [], pinnedRunnerId: '', noProgressLimit: String(DEFAULT_NO_PROGRESS_LIMIT),
      bashMode: 'raw', approvalTimeoutMinutes: minutesText(DEFAULT_APPROVAL_TIMEOUT_SEC),
    }
  }
  return {
    name: s.name, repoId: s.repoId, feature: s.feature, cron: s.cron, timezone: s.timezone, ref: s.ref,
    profiles: [...s.profiles], maxCostUsd: trimDecimal(s.maxCostUsd), placement: placementOf(s),
    selectorLabels: [...s.selectorLabels], pinnedRunnerId: s.pinnedRunnerId ?? '', noProgressLimit: String(s.noProgressLimit),
    bashMode: s.bashMode, approvalTimeoutMinutes: minutesText(s.approvalTimeoutSec),
  }
}

function numbers(v: Pick<ScheduleFormValues, 'maxCostUsd' | 'noProgressLimit'>): { maxCostUsd: number; noProgressLimit: number } {
  const maxCostUsd = parseMaxCost(v.maxCostUsd)
  const noProgressLimit = parseNoProgressLimit(v.noProgressLimit)
  if (maxCostUsd === null || noProgressLimit === null) throw new Error('fleet-schedules: form values were not validated')
  return { maxCostUsd, noProgressLimit }
}

/** Only the field of the chosen placement mode travels (D218). */
export function toCreateScheduleBody(v: ScheduleFormValues): NewScheduleBody {
  const ref = v.ref.trim()
  const pin = v.pinnedRunnerId.trim()
  return {
    name: v.name.trim(),
    repoId: v.repoId,
    feature: v.feature.trim(),
    cron: normalizeCron(v.cron),
    timezone: v.timezone.trim(),
    ...(ref ? { ref } : {}),
    ...(v.profiles.length > 0 ? { profiles: [...v.profiles] } : {}),
    ...numbers(v),
    ...(v.placement === 'pin' && pin ? { pinnedRunnerId: pin } : {}),
    ...(v.placement === 'labels' && v.selectorLabels.length > 0 ? { selectorLabels: [...v.selectorLabels] } : {}),
    ...bashCreateFields(v.bashMode, v.approvalTimeoutMinutes),
  }
}

/** Every editable field, always: an omitted field means "unchanged" (3a D203), so a cleared placement is explicit. */
export function toSchedulePatchBody(v: ScheduleFormValues): SchedulePatchBody {
  return {
    name: v.name.trim(),
    cron: normalizeCron(v.cron),
    timezone: v.timezone.trim(),
    ref: v.ref.trim(),
    profiles: [...v.profiles],
    ...numbers(v),
    selectorLabels: v.placement === 'labels' ? [...v.selectorLabels] : [],
    pinnedRunnerId: v.placement === 'pin' ? v.pinnedRunnerId.trim() : null,
    ...bashPatchFields(v.bashMode, v.approvalTimeoutMinutes),
  }
}

const ZONE_FORMAT = { dateStyle: 'medium', timeStyle: 'short' } as const

/** An instant in the schedule's own zone (D220); UTC when the runtime does not know the zone. */
export function formatInZone(iso: string | null, timeZone: string, locale?: string): string {
  if (!iso) return '-'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(locale, { ...ZONE_FORMAT, timeZone }).format(date)
  }
  catch {
    return new Intl.DateTimeFormat(locale, { ...ZONE_FORMAT, timeZone: 'UTC' }).format(date)
  }
}

export type ScheduleStatusKey = 'enabled' | ScheduleDisabledReason

/** `fleet.schedules.status.<key>`; a disabled schedule without a stored reason reads as manual. */
export const scheduleStatusKey = (s: Pick<ScheduleDto, 'enabled' | 'disabledReason'>): ScheduleStatusKey =>
  s.enabled ? 'enabled' : (s.disabledReason ?? 'manual')

export interface ScheduleViewer {
  userId: string | null
  /** Project ADMIN or DEVELOPER (canWorkOnFleet). */
  canWork: boolean
  /** Project ADMIN, or a global ADMIN (the members endpoint reports both as canManage). */
  canManage: boolean
}

/** Edit, enable, disable, delete (3a D202): DEVELOPER+ and the owner or a project ADMIN. */
export const canChangeSchedule = (s: Pick<ScheduleDto, 'createdById'>, viewer: ScheduleViewer): boolean =>
  viewer.canWork && (viewer.canManage || (viewer.userId !== null && viewer.userId === s.createdById))

export const sortSchedules = (schedules: readonly ScheduleDto[]): ScheduleDto[] =>
  [...schedules].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

export interface HistoryRow {
  job: FleetJobDto
  passed: number | null
  total: number | null
  /** Newly passed stories against the previous run; null when unknown (D221). */
  delta: number | null
  cost: string
  wipPush: WipPushStatus | null
  budgetPolicyId: string | null
}

/**
 * `jobs` newest first, as the jobs API returns them. The baseline is the nearest older loaded job with progress; when
 * `oldestLoaded` (the last page) and there is none, the baseline is 0 (D221).
 */
export function historyRows(jobs: readonly FleetJobDto[], oldestLoaded: boolean): HistoryRow[] {
  const progress = jobs.map((job) => extractProgress(job.progress))
  return jobs.map((job, i) => {
    const own = progress[i]
    const older = progress.slice(i + 1).find((entry) => entry !== null) ?? null
    const baseline = older !== null ? older.passed : oldestLoaded ? 0 : null
    return {
      job,
      passed: own?.passed ?? null,
      total: own?.total ?? null,
      delta: own !== null && baseline !== null ? own.passed - baseline : null,
      cost: formatUsd(job.costSpentUsd),
      wipPush: wipPushStatus(job.wipPush),
      budgetPolicyId: budgetStopPolicyId(job.stateReason),
    }
  })
}

export function formatDelta(delta: number | null): string {
  if (delta === null) return '-'
  return delta > 0 ? `+${delta}` : String(delta)
}
