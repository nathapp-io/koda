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
  /** Computed server-side (global ADMIN, or a project ADMIN member). */
  canManage?: boolean
}

export function useProjectMembers(slug: string) {
  const { $api } = useApi()
  const base = `/projects/${encodeURIComponent(slug)}/members`
  const members = ref<ProjectMember[]>([])
  const total = ref(0)
  const current = ref(1)
  const hasNext = ref(false)
  const canManage = ref(false)

  async function fetchPage(pageNumber: number): Promise<MemberPage> {
    const query: Record<string, string> = pageNumber > 1 ? { current: String(pageNumber) } : {}
    return $api.get<MemberPage>(base, { query })
  }

  async function fetchInto(targetPage: number, append: boolean): Promise<void> {
    const res = await fetchPage(targetPage)
    members.value = append ? [...members.value, ...(res.records ?? [])] : (res.records ?? [])
    total.value = append ? (res.total ?? total.value) : (res.total ?? 0)
    current.value = targetPage
    hasNext.value = res.hasNext === true
    // The API computes this from live membership, so it is correct even when
    // the caller's own ADMIN row is on a later page. Absent only on old servers.
    if (typeof res.canManage === 'boolean') canManage.value = res.canManage
  }

  async function load(): Promise<void> {
    await fetchInto(1, false)
  }

  /** Refetch the page currently shown, without resetting pagination. */
  async function reload(): Promise<void> {
    await fetchInto(current.value, false)
  }

  async function loadMore(): Promise<void> {
    await fetchInto(current.value + 1, true)
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

  return { members, total, current, hasNext, canManage, load, reload, loadMore, add, changeRole, remove }
}
