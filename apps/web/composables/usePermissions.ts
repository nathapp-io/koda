/**
 * Permissions P1 US-006: SSR-friendly fetches of the caller's effective permission keys.
 *
 * Gates read from these, never from a role name — roles are data, and a custom role has to work.
 * `useAsyncData` runs on the server during SSR and again during hydration, so the keys are known
 * before the first render and a gated control does not flash into view later (the same reason
 * `useProjectViewerRole` used it).
 *
 * Fail closed: a pending, failed or not-yet-requested fetch exposes `EMPTY_PERMISSIONS`, so every
 * gated control is hidden. A control that never renders is the safe direction; the API still
 * refuses anything the caller may not do, and the caller still surfaces its answer.
 *
 * What `useAsyncData` holds is the raw key list, not a `PermissionSet`: Nuxt serialises each async
 * data result into the hydration payload with `devalue`, which cannot stringify a function. The set
 * (whose `has`/`hasOwn` are functions) is therefore built in the computed -- on the server for SSR
 * and again on the client after hydration.
 */
import { computed, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { EMPTY_PERMISSIONS, permissionSet } from '~/lib/permissions'
import type { PermissionSet } from '~/lib/permissions'

/** One `/me/permissions` answer (US-001). `keys` is what the gates read. */
interface MePermissionsResponse {
  scope?: string
  projectSlug?: string | null
  keys?: string[]
}

/** What `useAsyncData` stores: the keys exactly as the API sent them, so the payload stays JSON. */
type PermissionKeys = string[]

export interface Permissions {
  /** The caller's keys, or `EMPTY_PERMISSIONS` while they are unknown or being re-read. */
  permissions: ComputedRef<PermissionSet>
  /** True while a fetch is in flight. */
  pending: Ref<boolean>
  /** The last fetch failure, if any. */
  error: Ref<unknown>
  /** Ask the API again (after a role change, say). */
  refresh: () => Promise<void>
}

/** The slice of the Nuxt app `getCachedData` reads. */
interface CacheSource {
  isHydrating?: boolean
  payload: { data: Record<string, unknown> }
}

/**
 * One `/me/permissions` read per scope per server render. Vue SSR awaits a parent's serverPrefetch
 * before rendering its children, so a child instance of the same key (CommandPalette inside the layout)
 * starts after the parent's read has resolved, when 'defer' has nothing in flight to share; Nuxt then
 * fetches again unless getCachedData answers. Only an initial fetch is served from the payload: on the
 * server it reuses what this render already fetched (the payload is per request), and while hydrating it
 * reads the server's answer as Nuxt does by default. A client navigation and every refresh, hydrating or
 * not, read fresh keys. Nuxt skips its purge for a custom getCachedData, so a stale entry may outlive an
 * unmount; it is never read, because the client reads the payload only while hydrating a fresh server
 * render. (No static.data fallback: these keys are per user and never prerendered.)
 */
export function permissionsCachedData(key: string, nuxtApp: CacheSource, ctx: { cause: string }): PermissionKeys | undefined {
  if (ctx.cause !== 'initial') return undefined
  if (nuxtApp.isHydrating || import.meta.server) return nuxtApp.payload.data[key] as PermissionKeys | undefined
  return undefined
}

/**
 * Reads `/me/permissions` for one scope. `project` null means the global scope, which is the same
 * route without the query — the API answers global keys when no project is named.
 */
function usePermissionsFor(key: string, project: string | null): Permissions {
  const { data, pending, error, refresh } = useAsyncData<PermissionKeys>(
    key,
    async () => {
      const { $api } = useApi()
      const response = project === null
        ? await $api.get<MePermissionsResponse>('/me/permissions')
        : await $api.get<MePermissionsResponse>('/me/permissions', { query: { project } })
      const keys = response?.keys
      // A malformed answer closes every gate instead of unlocking anything.
      return Array.isArray(keys) ? [...keys] : []
    },
    {
      default: () => [],
      // 'defer': a second same-key instance reuses a read still in flight instead of aborting it and
      // starting another (Nuxt's default 'cancel').
      dedupe: 'defer',
      getCachedData: permissionsCachedData,
    },
  )

  return {
    // Any fetch in flight fails closed, a refresh included: Nuxt keeps the previous `data` while a
    // refresh runs, so reading `data` alone would show keys the caller may already have lost.
    permissions: computed(() =>
      pending.value || error.value ? EMPTY_PERMISSIONS : permissionSet(data.value ?? [])),
    pending,
    error,
    // A manual re-read (after a role change, say) must not reuse an older read still in flight, so it
    // overrides the 'defer' the initial fetch uses.
    refresh: async () => { await refresh({ dedupe: 'cancel' }) },
  }
}

/** The keys the caller holds globally (no project): `GET /me/permissions`. */
export function useGlobalPermissions(): Permissions {
  return usePermissionsFor('permissions-global', null)
}

/** The keys the caller holds in one project: `GET /me/permissions?project=<slug>`. */
export function useProjectPermissions(slug: string): Permissions {
  return usePermissionsFor(`permissions-project-${slug}`, slug)
}

/**
 * The keys the caller holds in a project whose slug is only known later — a WORKSPACE thread's home project, which
 * arrives with the thread itself.
 *
 * `useAsyncData` cannot help here: it needs the key at setup time and the slug is not known then, so the read is a
 * plain `$api` GET issued by a watcher over `slug()`. Fail closed like the other two: while a read is in flight, after
 * one failed, or before any slug has arrived, `permissions` is `EMPTY_PERMISSIONS`, so a gated control simply does not
 * render. A read that arrives after the slug moved on is dropped (a thread can be replaced under the page).
 */
export function useProjectPermissionsFor(slug: () => string | null): Permissions {
  const { $api } = useApi()
  const keys = ref<PermissionKeys | null>(null)
  const pending = ref(true)
  const error = ref<unknown>(null)
  /** The slug the latest read was started for; a response for an older one is stale and ignored. */
  let requested: string | null = null

  const permissions = computed(() =>
    pending.value || error.value !== null || keys.value === null
      ? EMPTY_PERMISSIONS
      : permissionSet(keys.value))

  const load = async (target: string): Promise<void> => {
    pending.value = true
    error.value = null
    // A new scope closes every gate until its own answer arrives, so keys of the previous project never leak.
    keys.value = null
    try {
      const response = await $api.get<MePermissionsResponse>('/me/permissions', { query: { project: target } })
      if (requested !== target) return
      const list = response?.keys
      // A malformed answer closes every gate instead of unlocking anything.
      keys.value = Array.isArray(list) ? [...list] : []
    } catch (err: unknown) {
      if (requested !== target) return
      error.value = err
    } finally {
      if (requested === target) pending.value = false
    }
  }

  watch(() => slug(), (target) => {
    requested = target
    if (target === null || target === '') {
      keys.value = null
      error.value = null
      pending.value = false
      return
    }
    // The read's own failure is recorded in `error` (which keeps the gates closed); it never escapes the page.
    void load(target).catch(() => undefined)
  }, { immediate: true })

  return {
    permissions,
    pending,
    error,
    refresh: async (): Promise<void> => {
      if (requested !== null && requested !== '') await load(requested)
    },
  }
}
