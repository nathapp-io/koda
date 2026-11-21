import { apiPath } from '~/lib/api-path'
import { checkProjectRoute } from '~/lib/project-route-check'

export default defineNuxtRouteMiddleware(async (to) => {
  if (!useAuth().isAuthenticated.value) return

  // Only a project route has anything to classify: without a project slug there is no lookup to
  // make, so no API client is built either (it reads runtime config and request context a
  // non-project route never needs).
  const slug = to.params.project
  if (typeof slug !== 'string' || slug === '') return

  const known = useState<string[]>('koda-known-projects', () => [])
  const { $api } = useApi()
  const verdict = await checkProjectRoute(slug, { known: known.value, fetchProject: s => $api.get(apiPath`/projects/${s}`) })
  if (verdict === 'found') known.value = [...known.value, slug]
  if (verdict === 'notFound') {
    return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
  }
})
