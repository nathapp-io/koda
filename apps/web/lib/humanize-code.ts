/**
 * A readable label for a raw server code with no translation key (`TICKET_CREATED` -> `Ticket created`).
 * Display only: callers keep the raw code available (a tooltip) so nothing is lost for debugging.
 */
export function humanizeCode(code: string): string {
  const words = code.trim().split(/[\s._-]+/).filter(Boolean).join(' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
