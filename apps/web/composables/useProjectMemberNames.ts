import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ProjectMember } from '~/composables/useProjectMembers'

/** Display names for user ids on fleet pages (requester column and filter); one page of 100 members. */
export function useProjectMemberNames(slug: string) {
  const { $api } = useApi()
  const members = ref<ProjectMember[]>([])

  async function load(): Promise<void> {
    const res = await $api.get<{ records?: ProjectMember[] }>(apiPath`/projects/${slug}/members`, { query: { size: '100' } })
    members.value = res.records ?? []
  }

  /** The member's name, else email; null when the id is not among the loaded members (a former member). */
  const nameOf = (userId: string): string | null => {
    const member = members.value.find(m => m.userId === userId)
    return member ? (member.name || member.email) : null
  }

  return { members, load, nameOf }
}
