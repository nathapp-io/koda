import type { TranslateNamed } from '~/lib/fleet-budgets'
import type { BashMode } from '~/lib/fleet-types'

/** apps/api dispatch-fleet-job.dto and create-schedule.dto (S1.5 §1.6). */
export const BASH_MODES = ['raw', 'gated', 'escalate'] as const
export const DEFAULT_APPROVAL_TIMEOUT_SEC = 600
export const MIN_APPROVAL_TIMEOUT_SEC = 30
export const MAX_APPROVAL_TIMEOUT_SEC = 3600

/** Plain decimal minutes, at most 2 decimals: no sign, exponent or comma. */
const MINUTES_RE = /^\d{1,2}(?:\.\d{1,2})?$/

export const usesRelay = (mode: BashMode): boolean => mode !== 'raw'

/** D298: typed minutes -> whole seconds in 30..3600, else null. */
export function parseTimeoutMinutes(input: string): number | null {
  const trimmed = input.trim()
  if (!MINUTES_RE.test(trimmed)) return null
  const sec = Math.round(Number(trimmed) * 60)
  return sec >= MIN_APPROVAL_TIMEOUT_SEC && sec <= MAX_APPROVAL_TIMEOUT_SEC ? sec : null
}

/** D298: stored seconds -> the minutes the form shows. Two decimals are within 0.3 s, so it round-trips exactly. */
export const minutesText = (sec: number): string => String(Math.round((sec / 60) * 100) / 100)

/** A raw job has no ask timeout to check. */
export const isBashTimeoutValid = (mode: BashMode, minutes: string): boolean =>
  !usesRelay(mode) || parseTimeoutMinutes(minutes) !== null

function seconds(minutes: string): number {
  const sec = parseTimeoutMinutes(minutes)
  if (sec === null) throw new Error('fleet-bash-mode: timeout was not validated')
  return sec
}

/** Dispatch and schedule create (D299, D300): a raw job sends neither field, so today's bodies are unchanged. */
export function bashCreateFields(mode: BashMode, minutes: string): { bashMode?: BashMode; approvalTimeoutSec?: number } {
  return usesRelay(mode) ? { bashMode: mode, approvalTimeoutSec: seconds(minutes) } : {}
}

/** Schedule PATCH (D300): the mode always travels; a raw patch omits the timeout so the stored one is kept (3a D203). */
export function bashPatchFields(mode: BashMode, minutes: string): { bashMode: BashMode; approvalTimeoutSec?: number } {
  return usesRelay(mode) ? { bashMode: mode, approvalTimeoutSec: seconds(minutes) } : { bashMode: 'raw' }
}

/** The "Shell approvals" line on the job and schedule pages (D297, D300). */
export function bashSummary(t: TranslateNamed, mode: BashMode, sec: number): string {
  if (!usesRelay(mode)) return t('fleet.bash.mode.raw')
  return t('fleet.bash.summary', { mode: t(`fleet.bash.mode.${mode}`), minutes: minutesText(sec) })
}
