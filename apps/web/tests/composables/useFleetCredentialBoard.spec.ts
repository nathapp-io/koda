import { afterEach, describe, expect, jest, test } from '@jest/globals'
import { ApiError } from '~/composables/useApi'
import type { CredentialBoard } from '~/lib/fleet-credential-board'

const g = globalThis as Record<string, unknown>
const BOARD: CredentialBoard = { generatedAt: '2026-10-07T00:00:00.000Z', warnDays: 7, runners: [], providers: [], profiles: [] }

async function load(get: jest.Mock) {
  g.useApi = () => ({ $api: { get } })
  return (await import('~/composables/useFleetCredentialBoard')).useFleetCredentialBoard()
}

describe('useFleetCredentialBoard (S3 §6)', () => {
  afterEach(() => { delete g.useApi })

  test('loads the board from the admin route', async () => {
    const get = jest.fn(async () => BOARD)
    const board = await load(get)
    await board.load()
    expect(get).toHaveBeenCalledWith('/fleet/credential-board')
    expect(board.data.value).toEqual(BOARD)
    expect(board.failed.value).toBe(false)
  })

  test.each([40003, 403])('a %s marks it forbidden and keeps no data', async (code) => {
    const board = await load(jest.fn(async () => { throw new ApiError(code, 'forbidden') }))
    await board.load()
    expect(board.forbidden.value).toBe(true)
    expect(board.data.value).toBeNull()
  })

  test('another error marks it failed and keeps the last board', async () => {
    const get = jest.fn<() => Promise<unknown>>().mockResolvedValueOnce(BOARD).mockRejectedValueOnce(new Error('down'))
    const board = await load(get)
    await board.load()
    await board.load()
    expect(board.failed.value).toBe(true)
    expect(board.data.value).toEqual(BOARD)
  })
})
