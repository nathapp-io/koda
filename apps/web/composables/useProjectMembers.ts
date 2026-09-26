import { ref } from 'vue'

export const ASSIGNABLE_MEMBER_ROLES = ['ADMIN', 'DEVELOPER', 'VIEWER'] as const
export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number]

export interface ProjectMember {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: string
}

interface MemberPage {
  records: ProjectMember[]
  total: number
  current: number
  hasNext: boolean
}

/** The API enforces this too; the UI only hides controls a user cannot use. */
export function canManageMembers(user: { id: string; role?: string } | null, members: ProjectMember[]): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return members.some((m) => m.userId === user.id && m.role === 'ADMIN')
}

export function useProjectMembers(slug: string) {
  const { $api } = useApi()
  const base = `/projects/${encodeURIComponent(slug)}/members`
  const members = ref<ProjectMember[]>([])
  const total = ref(0)
  const current = ref(1)
  const hasNext = ref(false)

  async function fetchPage(pageNumber: number): Promise<MemberPage> {
    const query: Record<string, string> = pageNumber > 1 ? { current: String(pageNumber) } : {}
    return $api.get<MemberPage>(base, { query })
  }

  async function load(): Promise<void> {
    const res = await fetchPage(1)
    members.value = res.records ?? []
    total.value = res.total ?? 0
    current.value = 1
    hasNext.value = res.hasNext === true
  }

  async function loadMore(): Promise<void> {
    const res = await fetchPage(current.value + 1)
    members.value = [...members.value, ...(res.records ?? [])]
    total.value = res.total ?? total.value
    current.value = res.current ?? current.value + 1
    hasNext.value = res.hasNext === true
  }

  async function add(email: string, role: AssignableMemberRole): Promise<void> {
    const added = await $api.post<ProjectMember>(base, { email, role })
    members.value = [...members.value, added]
    total.value += 1
  }

  async function changeRole(userId: string, role: AssignableMemberRole): Promise<void> {
    const updated = await $api.patch<ProjectMember>(`${base}/${encodeURIComponent(userId)}`, { role })
    members.value = members.value.map((m) => (m.userId === userId ? updated : m))
  }

  async function remove(userId: string): Promise<void> {
    await $api.delete(`${base}/${encodeURIComponent(userId)}`)
    members.value = members.value.filter((m) => m.userId !== userId)
    total.value = Math.max(0, total.value - 1)
  }

  return { members, total, hasNext, load, loadMore, add, changeRole, remove }
}
