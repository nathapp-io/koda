import { isNotFoundError } from '~/lib/not-found'

export type ProjectRouteVerdict = 'skip' | 'known' | 'found' | 'notFound' | 'unverified'

export interface ProjectRouteDeps {
  /** Slugs this tab already proved exist. */
  known: readonly string[]
  fetchProject: (slug: string) => Promise<unknown>
}

export async function checkProjectRoute(slug: unknown, deps: ProjectRouteDeps): Promise<ProjectRouteVerdict> {
  if (typeof slug !== 'string' || slug === '') return 'skip'
  if (deps.known.includes(slug)) return 'known'
  try {
    await deps.fetchProject(slug)
    return 'found'
  } catch (err) {
    return isNotFoundError(err) ? 'notFound' : 'unverified'
  }
}
