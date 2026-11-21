import { describe, expect, test } from '@jest/globals'
import { parseTicketRefQuery } from '../../lib/palette-tickets'

describe('parseTicketRefQuery', () => {
  test("AC-1: trims and normalizes a ticket ref", () => {
    expect(parseTicketRefQuery(' sb-12 ')).toEqual({ key: 'SB', number: 12 })
  })

  test("AC-2: rejects a ref without digits", () => {
    expect(parseTicketRefQuery('SB-')).toBeNull()
  })

  test("AC-3: rejects ticket number zero", () => {
    expect(parseTicketRefQuery('WEB-0')).toBeNull()
  })

  test('AC-4: rejects refs with more than nine digits', () => {
    expect(parseTicketRefQuery('WEB-1234567890')).toBeNull()
  })
})
