/**
 * Normalize capabilities array: trim whitespace, drop empty values,
 * deduplicate case-insensitively, preserve first-seen casing.
 */
export function normalizeCapabilities(input: string[]): string[] {
  const seen = new Map<string, string>() // lowercase → original
  for (const cap of input) {
    const trimmed = cap.trim()
    if (!trimmed) continue
    const lower = trimmed.toLowerCase()
    if (!seen.has(lower)) {
      seen.set(lower, trimmed)
    }
  }
  return Array.from(seen.values())
}
