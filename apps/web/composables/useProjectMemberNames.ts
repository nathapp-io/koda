import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import type { ProjectMember } from '~/composables/useProjectMembers'

/** Display names for user ids on fleet pages (requester column and filter); one page of 100 members. */
export function useProjectMemberNames(slug: string) {
  const { $api } = useApi()
  const members = ref<ProjectMember[]>([])
  const self = signedInUser()

  async function load(): Promise<void> {
    const res = await $api.get<{ records?: ProjectMember[] }>(apiPath`/projects/${slug}/members`, { query: { size: '100' } })
    members.value = res.records ?? []
  }

  /**
   * The member's name, else email. A global admin can open a project without being a member, so the
   * signed-in user is named too; null only when the id is neither (a former member).
   */
  const nameOf = (userId: string): string | null => {
    const member = members.value.find(m => m.userId === userId)
    if (member) return member.name || member.email
    const me = self?.value
    return me && me.id === userId ? (me.name || me.email) : null
  }

  return { members, load, nameOf }
}

interface SignedInUser { id: string, email: string, name?: string }

/** The signed-in user's ref, or null where the auth composable is absent (unit tests that only stub `useApi`). */
function signedInUser(): { readonly value: SignedInUser | null } | null {
  if (typeof useAuth !== 'function') return null
  return useAuth().user
}
