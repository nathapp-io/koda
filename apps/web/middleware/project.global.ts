import { apiPath } from '~/lib/api-path'
import { checkProjectRoute } from '~/lib/project-route-check'

export default defineNuxtRouteMiddleware(async (to) => {
  if (!useAuth().isAuthenticated.value) return
  const known = useState<string[]>('koda-known-projects', () => [])
  const { $api } = useApi()
  const slug = to.params.project
  const verdict = await checkProjectRoute(slug, { known: known.value, fetchProject: s => $api.get(apiPath`/projects/${s}`) })
  if (verdict === 'found' && typeof slug === 'string') known.value = [...known.value, slug]
  if (verdict === 'notFound') {
    return abortNavigation(createError({ statusCode: 404, statusMessage: 'Not Found', fatal: true }))
  }
})
