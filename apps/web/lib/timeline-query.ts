export interface TimelineQuery {
  eventTypes?: string
  from?: string
  to?: string
  cursor?: string
}

/** Local midnight of a calendar day; an out-of-range day normalizes (day 32 is the next month's first). */
function localDayStart(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return date
}

/**
 * `from` is local midnight of the selected day; `to` is the last millisecond before the *following* local day
 * starts. The next day's start is built from its own date rather than by adding a day to this one: a zone that
 * jumps forward at midnight has no 00:00 on the transition day, so `setDate(+1)` would carry the normalized 01:00
 * into the next day and pull its first hour into the bound.
 */
function localDateBound(value: string, isEnd: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value

  const [, year, month, day] = match
  const start = localDayStart(Number(year), Number(month), Number(day))
  if (!isEnd) return start.toISOString()
  const nextDayStart = localDayStart(Number(year), Number(month), Number(day) + 1)
  return new Date(nextDayStart.getTime() - 1).toISOString()
}

export function buildTimelineQuery(
  filters: TimelineQuery,
): Record<string, string> {
  const query: Record<string, string> = {}
  if (filters.eventTypes) query.eventTypes = filters.eventTypes
  if (filters.from) query.from = localDateBound(filters.from, false)
  if (filters.to) query.to = localDateBound(filters.to, true)
  if (filters.cursor) query.cursor = filters.cursor
  return query
}
