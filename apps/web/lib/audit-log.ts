/**
 * The audit page's query model (Permissions P2 US-003): the URL query and the `GET /audit` query are
 * two projections of one `AuditFilters` value, so moving between them never loses or reinterprets a
 * filter. Pure — no Vue, no fetch.
 */

export type AuditActorType = 'USER' | 'AGENT' | 'RUNNER' | 'SYSTEM'

/** The four values `ListAuditQuery.actorType` accepts; the selects offer them in this order. */
export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['USER', 'AGENT', 'RUNNER', 'SYSTEM']

/** One audit query, as the URL carries it. An empty string is "not set"; `page` is 1-based. */
export interface AuditFilters {
  key: string
  actorType: AuditActorType | ''
  actorId: string
  approverId: string
  projectId: string
  resourceType: string
  resourceId: string
  /** Every write of one request or run. */
  correlationId: string
  /** 'YYYY-MM-DD' (a UTC day) or '' for an open window. */
  from: string
  to: string
  page: number
}

/** A route query value: the router hands strings, arrays of them, or nothing at all. */
type QueryValue = string | null | undefined | ReadonlyArray<string | null>

export const AUDIT_PAGE_SIZE = 50

/** The API caps every string filter at 128 characters (`ListAuditQuery`). */
const MAX_FIELD = 128

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

/**
 * A real UTC calendar day: right shape *and* an existing date. `2026-99-99` or `2026-02-30` match the
 * shape but the API's strict ISO-8601 validation refuses them, so sending one would answer 400.
 */
function isCalendarDate(value: string): boolean {
  const match = DATE_RE.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) return false
  const lastDay = month === 2 && isLeapYear(year) ? 29 : MONTH_DAYS[month - 1]
  return day >= 1 && day <= lastDay
}

/** The filter fields, in the order the selects and chips read them. */
const FILTER_FIELDS = [
  'key',
  'actorType',
  'actorId',
  'approverId',
  'projectId',
  'resourceType',
  'resourceId',
  'correlationId',
  'from',
  'to',
] as const

type FilterField = (typeof FILTER_FIELDS)[number]

export const EMPTY_AUDIT_FILTERS: AuditFilters = {
  key: '',
  actorType: '',
  actorId: '',
  approverId: '',
  projectId: '',
  resourceType: '',
  resourceId: '',
  correlationId: '',
  from: '',
  to: '',
  page: 1,
}

/** A route query value: the first string of an array, trimmed; anything else is ''. */
function first(value: QueryValue): string {
  const raw = Array.isArray(value) ? value[0] : value
  return typeof raw === 'string' ? raw.trim() : ''
}

/** Cut to `max` UTF-16 units without leaving half of a surrogate pair (encodeURIComponent throws on one). */
function cut(value: string, max: number): string {
  if (value.length <= max) return value
  const head = value.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head
}

function isActorType(value: string): value is AuditActorType {
  return (AUDIT_ACTOR_TYPES as readonly string[]).includes(value)
}

/** A date filter the API would refuse (`@IsISO8601` + `@Matches(YYYY-MM-DD)`) simply is not set. */
function dateOf(value: QueryValue): string {
  const raw = first(value)
  return isCalendarDate(raw) ? raw : ''
}

function pageOf(value: QueryValue): number {
  const raw = first(value)
  if (!/^\d{1,9}$/.test(raw)) return 1
  const page = Number(raw)
  return page >= 1 ? page : 1
}

/**
 * Lenient: an unknown actor type, a malformed date or a bad page falls back to the default instead
 * of failing the page, and over-long values are cut so a hand-edited URL never answers 400.
 */
export function parseAuditRoute(query: Record<string, QueryValue>): AuditFilters {
  const actorType = first(query.actorType)
  return {
    key: cut(first(query.key), MAX_FIELD),
    actorType: isActorType(actorType) ? actorType : '',
    actorId: cut(first(query.actorId), MAX_FIELD),
    approverId: cut(first(query.approverId), MAX_FIELD),
    projectId: cut(first(query.projectId), MAX_FIELD),
    resourceType: cut(first(query.resourceType), MAX_FIELD),
    resourceId: cut(first(query.resourceId), MAX_FIELD),
    from: dateOf(query.from),
    to: dateOf(query.to),
    correlationId: cut(first(query.correlationId), MAX_FIELD),
    page: pageOf(query.page),
  }
}

/** The URL query for the filters: only set fields, and the page only past the first. */
export function auditRouteQuery(filters: AuditFilters): Record<string, string> {
  const pairs: Array<[string, string]> = FILTER_FIELDS.map((field: FilterField) => [field, filters[field]])
  pairs.push(['page', filters.page > 1 ? String(filters.page) : ''])
  return Object.fromEntries(pairs.filter(([, value]) => value.length > 0))
}

/** The `GET /audit` query: the same filters under the API's names, plus its paging pairs. */
export function auditApiQuery(filters: AuditFilters): Record<string, string> {
  return {
    ...auditRouteQuery({ ...filters, page: 1 }),
    // The API refuses `current` below 1 (@Min(1)); a stray page 0 asks for the first page instead.
    current: String(Math.max(1, filters.page)),
    size: String(AUDIT_PAGE_SIZE),
  }
}

/** A new filter set with the patch applied; any filter change starts again at page 1. */
export function withFilter(filters: AuditFilters, patch: Partial<Omit<AuditFilters, 'page'>>): AuditFilters {
  return { ...filters, ...patch, page: 1 }
}

/** Every write of one request or run, and nothing else: the "show related" view. */
export function relatedFilters(correlationId: string): AuditFilters {
  return { ...EMPTY_AUDIT_FILTERS, correlationId }
}

/** The name a human reads for a principal: its resolved display name, else its id (SYSTEM never resolves). */
export function principalLabel(principal: { type: string; id: string }, name: string | null): string {
  const label = typeof name === 'string' ? name.trim() : ''
  return label.length > 0 ? label : principal.id
}
