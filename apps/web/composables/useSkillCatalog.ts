import { apiPath } from '~/lib/api-path'

export interface SkillDto {
  id: string
  name: string
  description: string
  dir: string
}

export interface SkillSourceDto {
  id: string
  gitUrl: string
  ref: string
  path: string
  resolvedSha: string | null
  resolvedAt: string | null
  status: string
  statusReason: string | null
  createdAt: string
  skills: SkillDto[]
}

export interface NewSkillSource {
  gitUrl: string
  path: string
  ref: string
}

const SOURCES = '/admin/skills/sources'

/** Global-admin skill catalog: registered skill sources, their pinned commit and their skills. */
export function useSkillCatalog() {
  const { $api } = useApi()

  async function list(): Promise<SkillSourceDto[]> {
    const res = await $api.get<{ items: SkillSourceDto[] }>(SOURCES)
    return res.items ?? []
  }

  async function create(input: NewSkillSource): Promise<SkillSourceDto> {
    return $api.post<SkillSourceDto>(SOURCES, { gitUrl: input.gitUrl, ref: input.ref, path: input.path })
  }

  /** Re-resolves the source at its ref; a source changes only when an admin asks for it. */
  async function update(id: string): Promise<SkillSourceDto> {
    return $api.post<SkillSourceDto>(apiPath`/admin/skills/sources/${id}/update`, {})
  }

  async function remove(id: string): Promise<void> {
    await $api.delete(apiPath`/admin/skills/sources/${id}`)
  }

  return { list, create, update, remove }
}
