import { describe, expect, test } from '@jest/globals'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const webDir = path.join(__dirname, '../..')
const read = (...parts: string[]): string => readFileSync(path.join(webDir, ...parts), 'utf-8')
const page = read('pages', '[project]', 'tickets', '[ref].vue')
const properties = read('components', 'TicketProperties.vue')

/** The body of the object literal passed to useProjectEvents(...). */
const liveHandlers = (source: string): string => {
  const start = source.indexOf('useProjectEvents(')
  expect(start).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n})', start))
}

describe('ticket page fleet wiring (C9 §4)', () => {
  test('Dispatch shows for DEVELOPER+ on an open ticket of a project with a fleet repo (D461, P2)', () => {
    expect(page).toContain("import { isLinkableTicket, ticketDispatchQuery } from '~/lib/fleet-ticket-links'")
    expect(page).toContain('apiPath`/projects/${slug}/fleet/repos`')
    expect(page).toContain("{ query: { size: '1' } }")
    expect(page).toMatch(/onMounted\(\(\) => \{\s*watch\(canWork, loadFleetRepoFlag, \{ immediate: true \}\)/)
    expect(page).toContain('if (!current || !canWork.value || !hasFleetRepo.value || !isLinkableTicket(current.status)) return null')
    expect(page).toContain('return { path: `/${slug}/fleet/dispatch`, query: ticketDispatchQuery(current) }')
    expect(page).toContain(':dispatch-href="dispatchHref"')
  })

  test('the Fleet runs card sits under the header and refreshes links after an unlink', () => {
    expect(page).toContain("import TicketFleetRuns from '~/components/TicketFleetRuns.vue'")
    expect(page).toMatch(/<TicketHeader[\s\S]*?\/>\s*<TicketFleetRuns[\s\S]*?:ticket-id="ticket\.id"[\s\S]*?:ticket-links="ticketLinks"[\s\S]*?:can-work="canWork"[\s\S]*?@changed="refetchAll\(\)"/)
  })

  test('live ticket events and resync also reload the links (P5: fleet PR links arrive as TICKET_UPDATED)', () => {
    const handlers = liveHandlers(page)
    expect(handlers.match(/void reloadLinksSilently\(\)/g)).toHaveLength(2)
  })

  test('fleet PR links carry a "via fleet" mark that links to the job (P6)', () => {
    expect(properties).toContain('source?: string')
    expect(properties).toContain('jobId?: string | null')
    expect(properties).toContain("v-if=\"link.source === 'fleet' && link.jobId\"")
    expect(properties).toContain(':to="`/${projectSlug}/fleet/jobs/${link.jobId}`"')
    expect(properties).toContain("v-else-if=\"link.source === 'fleet'\"")
    expect(properties.match(/data-testid="ticket-link-via-fleet"/g)).toHaveLength(2)
    expect(properties).toContain("t('fleet.tickets.viaFleet')")
  })
})
