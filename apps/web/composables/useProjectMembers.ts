/**
 * Permissions P1 US-013: the project member list, users and agents together.
 *
 * `GET /projects/:slug/members?principals=all` answers one row per principal — a user, or an agent
 * the project works with — and each row carries the role bindings it holds in this project. The row
 * is what the panel renders: a name, one chip per binding, and the principal id a binding write
 * needs. `bindings[].id` is null for a legacy membership row, which has no binding to delete.
 *
 * Writes: only `add` (an existing user by email, with a role key) lives here. Adding a role to a
 * principal, removing a binding and removing a whole row all go through `useRoleBindings`, so the
 * panel and the admin pages send the same requests.
 *
 * `ProjectMember` and `useProjectMemberNames` keep the default page (`principals=users`): display
 * names for fleet pages, mentions and the markdown editor only ever need user rows.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

/** One role a principal holds in this project. `id` is null for a legacy membership row. */
export interface MemberBinding {
  id: string | null
  roleKey: string
  roleName: string
}

export const PRINCIPAL_TYPES = ['USER', 'AGENT'] as const
/**
 * Named apart from `useRoleBindings`' `PrincipalType` on purpose: Nuxt auto-imports both modules, and
 * two exports with one name would leave only one of them auto-importable.
 */
export type ProjectPrincipalType = (typeof PRINCIPAL_TYPES)[number]

/** One row of `GET /projects/:slug/members?principals=all`. */
export interface ProjectPrincipalRow {
  principalType: ProjectPrincipalType
  principalId: string
  /** The `User.id`, or null for an agent. */
  userId: string | null
  /** The user's email, or null for an agent. */
  email: string | null
  /** The agent's slug, or null for a user. */
  agentSlug: string | null
  name: string | null
  disabled: boolean
  joinedAt: string
  bindings: MemberBinding[]
}

/**
 * A user row of the default members page. Kept for `useProjectMemberNames`, `lib/mentions.ts` and
 * `MarkdownEditor`, which read display names and never look at bindings.
 */
export interface ProjectMember {
  userId: string
  email: string
  name: string | null
  role: string
  joinedAt: string
  disabled: boolean
}

interface PrincipalPage {
  records?: ProjectPrincipalRow[]
  total?: number
  current?: number
  hasNext?: boolean
}

function isPrincipalType(value: unknown): value is ProjectPrincipalType {
  return value === 'USER' || value === 'AGENT'
}

function toBinding(value: unknown): MemberBinding | null {
  const binding = value as Partial<MemberBinding> | null
  if (typeof binding?.roleKey !== 'string') return null
  return {
    id: typeof binding.id === 'string' ? binding.id : null,
    roleKey: binding.roleKey,
    roleName: typeof binding.roleName === 'string' ? binding.roleName : binding.roleKey,
  }
}

/**
 * One row, whatever the server said. A response missing `principalType` (an older API answering the
 * default user page) is read as a user row, and a missing binding list as no bindings — the panel
 * renders what it can vouch for instead of failing on one malformed record.
 */
function toRow(value: unknown): ProjectPrincipalRow {
  const record = (value ?? {}) as Partial<ProjectPrincipalRow> & { userId?: string | null }
  const userId = typeof record.userId === 'string' ? record.userId : null
  const principalType = isPrincipalType(record.principalType) ? record.principalType : 'USER'
  const bindings = Array.isArray(record.bindings)
    ? record.bindings.map(toBinding).filter((binding): binding is MemberBinding => binding !== null)
    : []
  return {
    principalType,
    principalId: typeof record.principalId === 'string' ? record.principalId : (userId ?? ''),
    userId,
    email: typeof record.email === 'string' ? record.email : null,
    agentSlug: typeof record.agentSlug === 'string' ? record.agentSlug : null,
    name: typeof record.name === 'string' ? record.name : null,
    disabled: record.disabled === true,
    joinedAt: typeof record.joinedAt === 'string' ? record.joinedAt : '',
    bindings,
  }
}

export function useProjectMembers(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/members`
  const members = ref<ProjectPrincipalRow[]>([])
  const total = ref(0)
  const current = ref(1)
  const hasNext = ref(false)

  async function fetchPage(pageNumber: number): Promise<PrincipalPage> {
    // `principals=all` on every page: the agent rows sit after the user rows, so a user-only page
    // would silently drop them on the second page.
    const query: Record<string, string> = { principals: 'all' }
    if (pageNumber > 1) query.current = String(pageNumber)
    return $api.get<PrincipalPage>(base, { query })
  }

  async function fetchInto(targetPage: number, append: boolean): Promise<void> {
    const res = await fetchPage(targetPage)
    const records = Array.isArray(res?.records) ? res.records.map(toRow) : []
    members.value = append ? [...members.value, ...records] : records
    total.value = append ? (res.total ?? total.value) : (res.total ?? 0)
    current.value = targetPage
    hasNext.value = res.hasNext === true
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

  /**
   * Add an existing user by email and grant it `roleKey`. The route answers the new member row, so
   * it is appended instead of reloading the page the caller is looking at. A refusal throws: nothing
   * is appended and the caller decides what to say.
   */
  async function add(email: string, roleKey: string): Promise<ProjectPrincipalRow> {
    const created = await $api.post<ProjectPrincipalRow>(base, { email, roleKey })
    const row = toRow(created)
    members.value = [...members.value, row]
    total.value += 1
    return row
  }

  return { members, total, current, hasNext, load, reload, loadMore, add }
}
