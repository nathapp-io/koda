import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED'

/**
 * The public invite shape the API returns — never carries a raw token.
 *
 * Permissions P1 US-005 added the role-key fields: `role` is the legacy enum, `roleKey` the project
 * role the invite grants and `roleName` its label. All three are nullable because an invite stored
 * before the migration has no role row; an invite created since has all three unset or set together.
 * The panel renders `roleName`, never the raw key.
 */
export interface InviteDto {
  id: string
  email: string
  role: string | null
  roleKey: string | null
  roleName: string | null
  status: InviteStatus
  inviterName: string | null
  expiresAt: string
  createdAt: string
}

/** One result class: an existing account is added, a new address is invited. */
export interface InviteCreateResultDto {
  outcome: 'ADDED' | 'INVITED'
  member?: Record<string, unknown>
  invite?: InviteDto
  /** Present only on INVITED: the one-time raw-token path (D526). */
  invitePath?: string
  emailed?: boolean
}

export interface InviteResendResultDto {
  invite: InviteDto
  invitePath: string
  emailed: boolean
}

/** Join a one-time invite path with the current origin for the admin to copy. */
export function inviteLink(path: string): string {
  return `${window.location.origin}${path}`
}

export function useProjectInvites(slug: string) {
  const { $api } = useApi()
  const base = apiPath`/projects/${slug}/invites`
  const invites = ref<InviteDto[]>([])

  async function load(): Promise<void> {
    invites.value = await $api.get<InviteDto[]>(base)
  }

  /** Permissions P1 US-014: a project role key, not the legacy ADMIN/DEVELOPER/VIEWER enum. */
  async function create(email: string, roleKey: string): Promise<InviteCreateResultDto> {
    return $api.post<InviteCreateResultDto>(base, { email, roleKey })
  }

  async function resend(id: string): Promise<InviteResendResultDto> {
    return $api.post<InviteResendResultDto>(base + apiPath`/${id}/resend`)
  }

  async function cancel(id: string): Promise<void> {
    await $api.delete(base + apiPath`/${id}`)
  }

  return { invites, load, create, resend, cancel }
}
