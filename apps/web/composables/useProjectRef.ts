import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

/** What `GET /projects/:slug` answers, narrowed to what a caller resolving a route needs. */
interface ProjectRefAnswer {
  id?: string
}

/**
 * P3b US-001: a route's project slug resolved to its API id.
 *
 * The engine's list filters on `projectId`, while every project page routes on the slug, so a
 * project-scoped surface (the project inbox, the budget banner) needs this one lookup first.
 *
 * `load` throws: a failed `GET /projects/:slug` is the caller's to present (`web.md`: surface every
 * refusal with `extractApiError`), and the failure handling differs per surface — the inbox lists
 * nothing and toasts, the banner stays silent.
 */
export function useProjectRef(slug: string) {
  const { $api } = useApi()
  const id = ref<string | null>(null)

  async function load(): Promise<string | null> {
    const project = await $api.get<ProjectRefAnswer | null>(apiPath`/projects/${slug}`)
    id.value = project?.id ?? null
    return id.value
  }

  return { id, load }
}
