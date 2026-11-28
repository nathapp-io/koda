export interface TimelineQuery {
  eventTypes?: string
  from?: string
  to?: string
  cursor?: string
}

function localDateBound(value: string, isEnd: boolean): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value

  const [, year, month, day] = match
  const date = new Date(0)
  date.setFullYear(Number(year), Number(month) - 1, Number(day))
  date.setHours(0, 0, 0, 0)
  if (isEnd) {
    date.setDate(date.getDate() + 1)
    date.setMilliseconds(-1)
  }
  return date.toISOString()
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
