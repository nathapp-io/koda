/** Client-side copies of the API's fleet input rules, so a form fails before the request. */

/** apps/api/src/fleet/common LABEL_PATTERN; at most MAX_LABELS per runner or enrollment. */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/
export const MAX_LABELS = 20
export const CAPACITY_MIN = 1
export const CAPACITY_MAX = 16
/** CreateFleetRepoDto owner and name rules. */
export const REPO_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/
export const REPO_NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

export type LabelParse =
  | { ok: true; labels: string[] }
  | { ok: false; error: 'invalid'; label: string }
  | { ok: false; error: 'tooMany' }

/**
 * Splits a comma- or space-separated label list, trims, drops empties, de-duplicates
 * and sorts (the server sorts too). No case folding: an upper-case label is reported,
 * not silently changed.
 */
export function parseLabels(input: string): LabelParse {
  const labels = [...new Set(input.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part !== ''))].sort()
  const bad = labels.find((label) => !LABEL_PATTERN.test(label))
  if (bad !== undefined) return { ok: false, error: 'invalid', label: bad }
  if (labels.length > MAX_LABELS) return { ok: false, error: 'tooMany' }
  return { ok: true, labels }
}
