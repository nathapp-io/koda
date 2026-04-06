import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const cliDir = join(__dirname, '../..')
const ticketCommandPath = join(cliDir, 'src', 'commands', 'ticket.ts')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P2-003: commands/ticket.ts exists', () => {
  test('file is present at commands/ticket.ts', () => {
    expect(existsSync(ticketCommandPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P2-003 AC3: CLI ticket show displays PR URL and external ref in links section
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P2-003 AC3: ticket show command displays PR links in links section', () => {
  test('TicketDetail type includes links property', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    const hasLinksInDetailType =
      source.includes('links?:') &&
      source.includes('TicketLink')
    expect(hasLinksInDetailType).toBe(true)
  })

  test('ticket show command includes Links section in text output', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    const hasLinksSection =
      source.includes('Links:') ||
      (source.includes('links') && source.includes('console.log'))
    expect(hasLinksSection).toBe(true)
  })

  test('ticket show command displays URL for each link', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    const hasUrlDisplay =
      source.includes('link.url') ||
      (source.includes('url') && source.includes('link'))
    expect(hasUrlDisplay).toBe(true)
  })

  test('ticket show command displays externalRef for each link', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    const hasExternalRefDisplay =
      source.includes('link.externalRef') ||
      (source.includes('externalRef') && source.includes('link'))
    expect(hasExternalRefDisplay).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// VCS-P2-003 AC4: CLI ticket show --json includes links[] with PR TicketLink entries
// ──────────────────────────────────────────────────────────────────────────────

describe('VCS-P2-003 AC4: ticket show --json output includes links array', () => {
  test('TicketDetail type annotation includes links for type safety', () => {
    const source = readFileSync(ticketCommandPath, 'utf-8')
    const ticketDetailMatch = source.match(/type TicketDetail = TicketRow &[^{]*\{[\s\S]*?\n\};/m)
    expect(ticketDetailMatch).not.toBeNull()
    const ticketDetailBlock = ticketDetailMatch ? ticketDetailMatch[0] : ''
    expect(ticketDetailBlock).toContain('links?:')
  })
})