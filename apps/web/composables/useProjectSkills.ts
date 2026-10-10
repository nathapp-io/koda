import { apiPath } from '~/lib/api-path'

/** The catalog source a project skill comes from: pinned by the API, shown read-only here. */
export interface ProjectSkillSourceDto {
  id: string
  gitUrl: string
  ref: string
  resolvedSha: string | null
  status: string
}

/** One catalog skill as seen by one project: whether this project has it enabled. */
export interface ProjectSkillDto {
  id: string
  name: string
  description: string
  enabled: boolean
  source: ProjectSkillSourceDto
}

/** A project's view of the skill catalog, and the enable/disable toggles for project admins. */
export function useProjectSkills() {
  const { $api } = useApi()

  async function list(slug: string): Promise<ProjectSkillDto[]> {
    const res = await $api.get<{ items: ProjectSkillDto[] }>(apiPath`/projects/${slug}/skills`)
    return Array.isArray(res?.items) ? res.items : []
  }

  async function enable(slug: string, skillId: string): Promise<ProjectSkillDto> {
    return $api.put<ProjectSkillDto>(apiPath`/projects/${slug}/skills/${skillId}`)
  }

  async function disable(slug: string, skillId: string): Promise<void> {
    await $api.delete(apiPath`/projects/${slug}/skills/${skillId}`)
  }

  return { list, enable, disable }
}
