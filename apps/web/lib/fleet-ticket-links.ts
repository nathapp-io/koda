import type { FleetJobTicketDto, TicketFleetJobDto } from '~/lib/fleet-types'

/** apps/api/src/fleet/tickets/ticket-refs.ts MAX_DISPATCH_TICKETS (D450). */
export const MAX_DISPATCH_TICKETS = 20
/** A project key is 2-6 capitals (create-project.dto.ts); ticket numbers start at 1. */
export const TICKET_REF_RE = /^[A-Z]{2,6}-[1-9]\d{0,8}$/
/** D461: the longest feature slug a ticket's Dispatch button proposes. */
export const MAX_TICKET_FEATURE_CHARS = 48

export type TicketOption = FleetJobTicketDto

const UNLINKABLE: ReadonlySet<string> = new Set(['CLOSED', 'REJECTED'])
const REASON_STATES: ReadonlySet<string> = new Set(['FAILED', 'ESCALATED', 'CRASHED'])

/** D450: dispatch refuses CLOSED and REJECTED tickets. */
export const isLinkableTicket = (status: string): boolean => !UNLINKABLE.has(status)

/** `' web-7 '` -> `'WEB-7'`; null for anything that is not a ticket ref. */
export function normalizeTicketRef(value: string): string | null {
  const ref = value.trim().toUpperCase()
  return TICKET_REF_RE.test(ref) ? ref : null
}

/** `?tickets=WEB-1,web-2` (or repeated params) -> valid refs only, upper-cased, deduplicated, at most 20. */
export function ticketRefsFromQuery(value: unknown): string[] {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').join(',') : ''
  const refs = raw.split(',').map(normalizeTicketRef).filter((r): r is string => r !== null)
  return [...new Set(refs)].slice(0, MAX_DISPATCH_TICKETS)
}

/** One more ref, normalized; the list comes back unchanged (as a copy) for junk, a repeat or a full list. */
export function addTicketRef(list: readonly string[], value: string): string[] {
  const ref = normalizeTicketRef(value)
  if (ref === null || list.includes(ref) || list.length >= MAX_DISPATCH_TICKETS) return [...list]
  return [...list, ref]
}

/** Picker suggestions (P1): open tickets not yet chosen whose ref or title contains the query. */
export function matchTicketOptions(options: readonly TicketOption[], chosen: readonly string[], query: string, limit = 8): TicketOption[] {
  const q = query.trim().toLowerCase()
  return options
    .filter(o => isLinkableTicket(o.status) && !chosen.includes(o.ref) && (!q || `${o.ref} ${o.title}`.toLowerCase().includes(q)))
    .slice(0, limit)
}

/** D461: `WEB-12` + `Fix login` -> `web-12-fix-login`; `[a-z0-9-]`, at most 48 chars, never ending with `-`. */
export function ticketFeatureSlug(ref: string, title: string): string {
  const slug = `${ref}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug.slice(0, MAX_TICKET_FEATURE_CHARS).replace(/-+$/, '')
}

/** The ticket page's Dispatch link query (D461). */
export function ticketDispatchQuery(ticket: { ref: string; title: string }): Record<string, string> {
  return { command: 'PLAN', tickets: ticket.ref, feature: ticketFeatureSlug(ticket.ref, ticket.title) }
}

/** PLAN -> RUN hand-off (spec §4): the PLAN job's refs, comma-separated; empty when it has none. */
export function ticketsQueryValue(tickets: readonly FleetJobTicketDto[] | null | undefined): string {
  return (tickets ?? []).map(t => t.ref).join(',')
}

/** The reason a Fleet runs row shows; same choice as apps/api/src/fleet/tickets/failure-comment.ts. */
export function runReason(job: Pick<TicketFleetJobDto, 'state' | 'stateReason' | 'escalationReason'>): string | null {
  if (!REASON_STATES.has(job.state)) return null
  const raw = job.state === 'ESCALATED' ? (job.escalationReason?.trim() || job.stateReason) : job.stateReason
  return raw?.trim() || null
}

/** The live state of a run's PR, from the ticket's own link (the refresher keeps it current, D456). */
export function runPrState(
  job: Pick<TicketFleetJobDto, 'resultPrUrl'>,
  links: ReadonlyArray<{ url: string; prState?: string | null }>,
): string | null {
  if (!job.resultPrUrl) return null
  return links.find(l => l.url === job.resultPrUrl)?.prState ?? null
}

/** P3: a listed job changed, or a job was just queued (it may be linked to this ticket). */
export function affectsRuns(event: { jobId: string; state: string }, jobIds: readonly string[]): boolean {
  return jobIds.includes(event.jobId) || event.state === 'QUEUED'
}

export const shortSha = (sha: string | null): string | null => (sha ? sha.slice(0, 7) : null)
