/**
 * US-007 — useProjectInvites composable.
 *
 * The composable reads `useApi()` as a Nuxt auto-import, so the test injects a
 * recording `useApi` on globalThis (same pattern as tests/composables/useProjectMembers.spec.ts)
 * and imports the real module.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { existsSync } from 'fs'
import { join } from 'path'

const composablePath = join(__dirname, '..', '..', 'composables', 'useProjectInvites.ts')
const ORIGIN = 'http://localhost:3101'

function withApi(api: Record<string, jest.Mock>): void {
  (globalThis as Record<string, unknown>).useApi = () => ({ $api: api })
}

describe('useProjectInvites (US-007)', () => {
  beforeEach(() => {
    // RED guard: the composable must exist before behaviour can be exercised.
    expect(existsSync(composablePath)).toBe(true)
    ;(globalThis as Record<string, unknown>).useApi = undefined
    ;(globalThis as Record<string, unknown>).window = { location: { origin: ORIGIN } }
  })

  test('AC7: create posts exactly { email, role } to /projects/<slug>/invites', async () => {
    expect(existsSync(composablePath)).toBe(true)
    const post = jest.fn(async () => ({ outcome: 'ADDED' }))
    withApi({ post })
    const { useProjectInvites } = await import(composablePath)

    await useProjectInvites('my-project').create('a@b.io', 'ADMIN')

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0]).toEqual(['/projects/my-project/invites', { email: 'a@b.io', role: 'ADMIN' }])
  })

  test('AC7 boundary: a rejected post rejects create instead of swallowing the error', async () => {
    const post = jest.fn(async () => { throw new Error('forbidden') })
    withApi({ post })
    const { useProjectInvites } = await import(composablePath)

    await expect(useProjectInvites('my-project').create('a@b.io', 'VIEWER')).rejects.toThrow('forbidden')
  })

  test('load GETs the pending invites for the project and stores them', async () => {
    const invites = [{ id: 'i1', email: 'pending@x.io', role: 'DEVELOPER', status: 'PENDING' }]
    const get = jest.fn(async () => invites)
    withApi({ get })
    const { useProjectInvites } = await import(composablePath)
    const store = useProjectInvites('my-project')

    await store.load()

    expect(get.mock.calls[0]?.[0]).toBe('/projects/my-project/invites')
    expect(store.invites.value).toEqual(invites)
  })

  test('inviteLink joins window.location.origin with the invite path', async () => {
    const { inviteLink } = await import(composablePath)

    expect(inviteLink('/invite/tok123')).toBe(`${ORIGIN}/invite/tok123`)
  })
})
