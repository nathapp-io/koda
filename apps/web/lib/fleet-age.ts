export type AgeUnit = 's' | 'm' | 'h' | 'd'

export interface AgeParts {
  n: number
  unit: AgeUnit
}

const STEPS: ReadonlyArray<{ unit: AgeUnit; ms: number }> = [
  { unit: 'd', ms: 86_400_000 },
  { unit: 'h', ms: 3_600_000 },
  { unit: 'm', ms: 60_000 },
]

/**
 * Coarse age of `fromIso` at `now`, in the largest whole unit (59 s, 3 m, 5 h, 2 d).
 * Null for a missing or unparseable time. A time in the future (clock skew between
 * the API and the browser) reads as 0 s.
 */
export function ageParts(fromIso: string | null | undefined, now: Date): AgeParts | null {
  if (!fromIso) return null
  const from = Date.parse(fromIso)
  if (Number.isNaN(from)) return null
  const elapsed = Math.max(0, now.getTime() - from)
  const step = STEPS.find((s) => elapsed >= s.ms)
  return step ? { n: Math.floor(elapsed / step.ms), unit: step.unit } : { n: Math.floor(elapsed / 1000), unit: 's' }
}
