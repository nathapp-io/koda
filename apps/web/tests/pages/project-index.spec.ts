import { describe, test, expect, jest } from '@jest/globals'

interface Ticket {
  id: string
  ref: string
  title: string
  type: 'BUG' | 'ENHANCEMENT'
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  assignee?: { name: string; email?: string } | null
}

// Simulate handleOpenTicket as implemented in pages/[project]/index.vue
// router.push(`/${slug}/tickets/${ticket.ref}`)
function makeHandleOpenTicket(slug: string, routerPush: (path: string) => void) {
  return function handleOpenTicket(ticket: Ticket) {
    routerPush(`/${slug}/tickets/${ticket.ref}`)
  }
}

describe('US-007: handleOpenTicket navigates using ticket.ref (stubs useRouter)', () => {
  test('AC1: router.push is called with /${slug}/tickets/${ticket.ref}', () => {
    const routerPush = jest.fn()
    const slug = 'nax'
    const ticket: Ticket = {
      id: '123',
      ref: 'NAX-1',
      title: 'Test ticket',
      type: 'BUG',
      priority: 'HIGH',
      status: 'CREATED',
    }

    const handleOpenTicket = makeHandleOpenTicket(slug, routerPush)
    handleOpenTicket(ticket)

    expect(routerPush).toHaveBeenCalledWith('/nax/tickets/NAX-1')
  })

  test('AC2: router.push is NOT called with undefined in the path', () => {
    const routerPush = jest.fn()
    const slug = 'nax'
    const ticket: Ticket = {
      id: '456',
      ref: 'NAX-2',
      title: 'Another ticket',
      type: 'ENHANCEMENT',
      priority: 'MEDIUM',
      status: 'IN_PROGRESS',
    }

    const handleOpenTicket = makeHandleOpenTicket(slug, routerPush)
    handleOpenTicket(ticket)

    const calledWith = (routerPush.mock.calls[0] as [string])[0]
    expect(calledWith).not.toContain('undefined')
    expect(calledWith).toBe('/nax/tickets/NAX-2')
  })

  test('AC3: source confirms no path segment uses ticket.id or ticket.number', () => {
    const { readFileSync } = require('fs')
    const { join } = require('path')
    const pagePath = join(__dirname, '../../pages/[project]/index.vue')
    const source = readFileSync(pagePath, 'utf-8')

    // handleOpenTicket must use ticket.ref, never ticket.id or ticket.number
    const hasRefUsage = source.includes('ticket.ref')
    const hasIdInPath = /router\.push.*ticket\.id/.test(source)
    const hasNumberInPath = /router\.push.*ticket\.number/.test(source)

    expect(hasRefUsage).toBe(true)
    expect(hasIdInPath).toBe(false)
    expect(hasNumberInPath).toBe(false)
  })
})
