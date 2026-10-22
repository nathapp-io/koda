import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { serialize } from 'v8'
import { EMPTY_PERMISSIONS } from '~/lib/permissions'
import { useGlobalPermissions, useProjectPermissions } from '~/composables/usePermissions'
import { asyncCalls, fakeAsyncData, resetAsyncCalls } from '../helpers/permission-nav'

/**
 * US-006: `useGlobalPermissions` / `useProjectPermissions`.
 *
 * The composable is loaded as the real module; its two Nuxt auto-imports (`useAsyncData`, `useApi`)
 * are supplied on `globalThis`, which is where an undeclared auto-import identifier resolves at
 * runtime. So these tests exercise the composable's own code, not a re-implementation of it, and
 * `fakeAsyncData` (tests/helpers/permission-nav.ts) records what each fetch stored.
 */

const globals = globalThis as unknown as Record<string, unknown>

/** Installs the auto-import doubles for one test; returns the `$api.get` spy. */
function install(handler: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
  const get = jest.fn(handler)
  globals.useAsyncData = fakeAsyncData
  globals.useApi = () => ({ $api: { get } })
  return get
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

beforeEach(() => {
  resetAsyncCalls()
})

afterEach(() => {
  delete globals.useAsyncData
  delete globals.useApi
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-4 — the project scope reads the project's own keys
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-4: useProjectPermissions reads the project scope', () => {
  test('AC-4: asks for the project and exposes the keys it was given', async () => {
    const get = install(async () => ({ scope: 'project', projectSlug: 'web', keys: ['ticket.create', 'comment.update.own'] }))

    const { permissions } = useProjectPermissions('web')
    await settle()

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]).toEqual(['/me/permissions', { query: { project: 'web' } }])
    expect(permissions.value.has('ticket.create')).toBe(true)
    expect(permissions.value.has('ticket.delete')).toBe(false)
  })

  test('AC-4 (edge): the fetched set also answers the own question', async () => {
    install(async () => ({ scope: 'project', projectSlug: 'web', keys: ['ticket.update.own'] }))

    const { permissions } = useProjectPermissions('web')
    await settle()

    expect(permissions.value.hasOwn('ticket.update')).toBe(true)
    expect(permissions.value.has('ticket.update')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-5 — a rejected fetch fails closed
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-5: a failed fetch exposes EMPTY_PERMISSIONS and the error', () => {
  test('AC-5: permissions is the empty set and error is the rejection', async () => {
    const failure = new Error('403 forbidden')
    const get = install(async () => { throw failure })

    const { permissions, error, pending } = useProjectPermissions('web')
    await settle()

    expect(get).toHaveBeenCalled()
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
    expect(error.value).toBe(failure)
    expect(pending.value).toBe(false)
  })

  test('AC-5: every gate on the failed set answers false', async () => {
    install(async () => { throw new Error('boom') })

    const { permissions } = useGlobalPermissions()
    await settle()

    expect(permissions.value.has('user.read')).toBe(false)
    expect(permissions.value.hasOwn('user.read')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-6 — the two scopes use distinct useAsyncData keys and calls
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-6: the global scope asks with no query, under its own key', () => {
  test('AC-6: useGlobalPermissions calls GET /me/permissions with no options', async () => {
    const get = install(async () => ({ scope: 'global', projectSlug: null, keys: ['user.read'] }))

    const { permissions } = useGlobalPermissions()
    await settle()

    expect(get.mock.calls[0]).toEqual(['/me/permissions'])
    expect(permissions.value.has('user.read')).toBe(true)
    expect(asyncCalls.map((call) => call.key)).toEqual(['permissions-global'])
  })

  test('AC-6: useProjectPermissions keys the cache per project slug', async () => {
    install(async () => ({ scope: 'project', projectSlug: 'web', keys: [] }))

    useProjectPermissions('web')
    await settle()

    expect(asyncCalls.map((call) => call.key)).toEqual(['permissions-project-web'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// US-006 AC-12 — a pending fetch fails closed too
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006 AC-12: a pending fetch exposes EMPTY_PERMISSIONS', () => {
  test('AC-12: while the global fetch is outstanding the set holds nothing', async () => {
    install(() => new Promise(() => undefined))

    const { permissions, pending, error } = useGlobalPermissions()
    await settle()

    expect(pending.value).toBe(true)
    expect(error.value).toBeNull()
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
  })

  test('AC-12: while the project fetch is outstanding the set holds nothing', async () => {
    install(() => new Promise(() => undefined))

    const { permissions, pending } = useProjectPermissions('web')
    await settle()

    expect(pending.value).toBe(true)
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// refresh() re-asks the API and swaps the set in
// ─────────────────────────────────────────────────────────────────────────────

describe('US-006: refresh re-reads the keys', () => {
  test('refresh fetches again and the gates follow the new answer', async () => {
    let answer: string[] = []
    install(async () => ({ scope: 'global', projectSlug: null, keys: answer }))

    const { permissions, refresh } = useGlobalPermissions()
    await settle()
    expect(permissions.value.has('fleet.ingest.read')).toBe(false)

    answer = ['fleet.ingest.read']
    await refresh()
    await settle()

    expect(permissions.value.has('fleet.ingest.read')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1 / F1 — the value handed to useAsyncData must survive the SSR payload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Nuxt serialises each `useAsyncData` result into the hydration payload (`devalue`, which throws
 * `Cannot stringify a function`). `devalue` ships ESM only and this Jest project is CommonJS, so the
 * automated check uses Node's own structured-clone serializer, which rejects exactly the construct
 * that broke the payload: a function. The devalue probe itself is recorded in the story report.
 */
describe('F1: the useAsyncData payload is serializable', () => {
  test('F1: the resolved value and the default both survive serialisation, so SSR hydration works', async () => {
    install(async () => ({ scope: 'global', projectSlug: null, keys: ['user.read'] }))

    useGlobalPermissions()
    await settle()

    const call = asyncCalls[0]
    expect(() => serialize({ [call.key]: call.options?.default?.() })).not.toThrow()
    expect(() => serialize({ [call.key]: call.resolved })).not.toThrow()
    // The payload carries the keys themselves; the PermissionSet is built on the client.
    expect(call.resolved).toEqual(['user.read'])
  })

  test('F1 (project scope): the payload is the project keys, not a set of functions', async () => {
    install(async () => ({ scope: 'project', projectSlug: 'web', keys: ['ticket.create'] }))

    useProjectPermissions('web')
    await settle()

    const call = asyncCalls[0]
    expect(call.resolved).toEqual(['ticket.create'])
    expect(() => serialize({ [call.key]: call.resolved })).not.toThrow()
  })

  test('F1 (edge): a payload holding a function is rejected by the same check', () => {
    // Guards the assertion itself: if this did not throw, F1 would pass on the broken shape.
    expect(() => serialize({ 'permissions-global': { has: () => false } })).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Fix round 1 / F2 — a refresh in flight fails closed, like the initial fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('F2: a refresh in flight exposes EMPTY_PERMISSIONS', () => {
  /** A fetch whose behaviour the test switches between granting, deferring and failing. */
  function stagedGet() {
    let phase: 'grant' | 'defer' | 'fail' = 'grant'
    const get = install(() => {
      if (phase === 'defer') return new Promise(() => undefined)
      if (phase === 'fail') return Promise.reject(new Error('boom'))
      return Promise.resolve({ scope: 'global', projectSlug: null, keys: ['user.read', 'fleet.ingest.read'] })
    })
    return { get, set: (next: 'grant' | 'defer' | 'fail') => { phase = next } }
  }

  test('F2 (global): after a grant, a deferred refresh closes every gate again', async () => {
    const staged = stagedGet()
    const { permissions, pending, refresh } = useGlobalPermissions()
    await settle()
    expect(permissions.value.has('user.read')).toBe(true)

    staged.set('defer')
    void refresh()
    await settle()

    expect(pending.value).toBe(true)
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
  })

  test('F2 (project): the same holds for the project scope', async () => {
    const staged = stagedGet()
    const { permissions, pending, refresh } = useProjectPermissions('web')
    await settle()
    expect(permissions.value.has('fleet.ingest.read')).toBe(true)

    staged.set('defer')
    void refresh()
    await settle()

    expect(pending.value).toBe(true)
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
  })

  test('F2 (edge): a refresh that fails keeps failing closed', async () => {
    const staged = stagedGet()
    const { permissions, error, refresh } = useGlobalPermissions()
    await settle()
    expect(permissions.value.has('user.read')).toBe(true)

    staged.set('fail')
    await refresh()
    await settle()

    expect(error.value).toBeInstanceOf(Error)
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)
  })

  test('F2: once the refresh resolves the gates come back', async () => {
    const staged = stagedGet()
    const { permissions, refresh } = useGlobalPermissions()
    await settle()

    staged.set('defer')
    void refresh()
    await settle()
    expect(permissions.value).toBe(EMPTY_PERMISSIONS)

    staged.set('grant')
    await refresh()
    await settle()
    expect(permissions.value.has('user.read')).toBe(true)
  })
})
