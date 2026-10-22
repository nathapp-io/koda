/**
 * Permissions P1 US-013: the PROJECT-scope roles a member of one project can be given.
 *
 * `GET /projects/:slug/roles` answers behind the project gate (`member.read`), so a project admin
 * who does not hold the global `role.read` can still list the vocabulary it hands out. The panel and
 * the invites panel both read it, so the fetch lives here instead of in either component.
 *
 * Loading is once per composable instance: the select's options do not change while the page is
 * open, and re-asking on every render would put a request behind each keystroke. A failed load is
 * not memoised — the caller may retry — and a second caller while the first is in flight waits for
 * that same request instead of starting its own.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

export interface ProjectRole {
  id: string
  key: string
  name: string
  description: string
  /** A seeded role rather than one the installation created. */
  system: boolean
}

function isProjectRole(value: unknown): value is ProjectRole {
  const role = value as Partial<ProjectRole> | null
  return typeof role?.id === 'string' && typeof role.key === 'string' && typeof role.name === 'string'
}

export function useProjectRoles(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/roles`

  const roles = ref<ProjectRole[]>([])
  const pending = ref(false)
  const error = ref<unknown>(null)

  let loaded = false
  let inflight: Promise<void> | null = null

  async function fetchRoles(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<ProjectRole[]>(base)
      // A malformed row is dropped rather than rendered as a nameless option.
      roles.value = Array.isArray(res) ? res.filter(isProjectRole) : []
      loaded = true
      error.value = null
    }
    catch (err: unknown) {
      error.value = err
      throw err
    }
    finally {
      pending.value = false
      inflight = null
    }
  }

  /** The project roles, fetched at most once unless the first attempt failed. */
  async function load(): Promise<ProjectRole[]> {
    if (loaded) return roles.value
    if (!inflight) inflight = fetchRoles()
    await inflight
    return roles.value
  }

  return { roles, pending, error, load }
}
