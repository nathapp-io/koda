export const PALETTE_TICKET_SEARCH_MIN = 2
export const PALETTE_TICKET_SEARCH_SIZE = 8
export const PALETTE_TICKET_SEARCH_DEBOUNCE_MS = 250

export function parseTicketRefQuery(query: string): { key: string; number: number } | null {
  const match = /^([A-Za-z]+)-(\d+)$/.exec(query.trim())
  if (!match || match[2].length > 9) return null

  const number = Number.parseInt(match[2], 10)
  if (number === 0) return null

  return { key: match[1].toUpperCase(), number }
}
