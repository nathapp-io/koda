import { describe, expect, test } from '@jest/globals'
import { humanizeCode } from '../../lib/humanize-code'

describe('humanizeCode', () => {
  test.each([
    ['TICKET_CREATED', 'Ticket created'],
    ['status_changed', 'Status changed'],
    ['CODE_INDEXED', 'Code indexed'],
    ['decided', 'Decided'],
    ['agent.task-done', 'Agent task done'],
    ['  spaced__code  ', 'Spaced code'],
  ])('%s -> %s', (code, label) => {
    expect(humanizeCode(code)).toBe(label)
  })

  test('an empty code stays empty', () => {
    expect(humanizeCode('')).toBe('')
  })
})
