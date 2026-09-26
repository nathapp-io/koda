import { ref } from 'vue'

export type GlobalRole = 'MEMBER' | 'ADMIN'

export interface AdminUser {
  id: string
  email: string
  name: string | null
  role: GlobalRole
  disabled: boolean
  createdAt: string
}

export interface AdminUserPage {
  records: AdminUser[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export interface NewUser {
  email: string
  name: string
  password: string
  role: GlobalRole
}

export function buildUserQuery(filters: { email?: string; page?: number }): Record<string, string> {
  const query: Record<string, string> = {}
  const email = filters.email?.trim()
  if (email) query.email = email
  if (filters.page && filters.page > 1) query.current = String(filters.page)
  return query
}

export function useAdminUsers() {
  const { $api } = useApi()
  const users = ref<AdminUser[]>([])
  const total = ref(0)
  const page = ref(1)
  const hasNext = ref(false)
  const pending = ref(false)

  async function load(filters: { email?: string; page?: number } = {}): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<AdminUserPage>('/admin/users', { query: buildUserQuery(filters) })
      users.value = res.records ?? []
      total.value = res.total ?? 0
      page.value = res.current ?? 1
      hasNext.value = res.hasNext === true
    } finally {
      pending.value = false
    }
  }

  function replace(updated: AdminUser): void {
    users.value = users.value.map((u) => (u.id === updated.id ? updated : u))
  }

  async function createUser(input: NewUser): Promise<AdminUser> {
    return $api.post<AdminUser>('/admin/users', { ...input })
  }

  async function setDisabled(id: string, disabled: boolean): Promise<void> {
    replace(await $api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { disabled }))
  }

  async function setRole(id: string, role: GlobalRole): Promise<void> {
    replace(await $api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, { role }))
  }

  return { users, total, page, hasNext, pending, load, createUser, setDisabled, setRole }
}
