import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { ref, shallowRef } from 'vue'
import type { Ref } from 'vue'
import { EMPTY_PERMISSIONS } from '~/lib/permissions'
import { useGlobalPermissions, useProjectPermissions } from '~/composables/usePermissions'

/**
 * US-006: `useGlobalPermissions` / `useProjectPermissions`.
 *
 * The composable is loaded as the real module; its two Nuxt auto-imports (`useAsyncData`, `useApi`)
 * are supplied on `globalThis`, which is where an undeclared auto-import identifier resolves at
 * runtime. So these tests exercise the composable's own code, not a re-implementation of it.
 */

interface AsyncCall {
  key: string
  options?: { default?: () => unknown }
}

let asyncCalls: AsyncCall[] = []

interface AsyncData<T> {
  data: Ref<T | null>
  pending: Ref<boolean>
  error: Ref<unknown>
  refresh: () => Promise<void>
}

/**
 * Nuxt's `useAsyncData` in miniature: `data` is a shallow ref that starts at the `default` option,
 * the handler runs at once, a rejection lands in `error` and leaves `data` where it was, and
 * `refresh` runs it again.
 */
function fakeUseAsyncData<T>(
  key: string,
  run: () => Promise<T>,
  options?: { default?: () => T },
): AsyncData<T> {
  asyncCalls.push({ key, options })
  const data = shallowRef<T | null>(options?.default ? options.default() : null) as Ref<T | null>
  const pending = ref(true)
  const error = ref<unknown>(null)
  const load = (): Promise<void> =>
    run().then(
      (value) => { data.value = value; pending.value = false },
      (err: unknown) => { error.value = err; pending.value = false },
    )
  void load()
  return { data, pending, error, refresh: load }
}

const globals = globalThis as unknown as Record<string, unknown>

/** Installs the auto-import doubles for one test; returns the `$api.get` spy. */
function install(handler: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
  const get = jest.fn(handler)
  globals.useAsyncData = fakeUseAsyncData
  globals.useApi = () => ({ $api: { get } })
  return get
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve) })
}

beforeEach(() => {
  asyncCalls = []
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
