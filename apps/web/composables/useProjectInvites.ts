import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'

/** Fleet S4b US-007: the only roles a project admin may invite (AGENT is not assignable). */
export const INVITE_ROLES = ['ADMIN', 'DEVELOPER', 'VIEWER'] as const
export type InviteRole = (typeof INVITE_ROLES)[number]

export type InviteStatus = 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'CANCELLED'

/** The public invite shape the API returns — never carries a raw token. */
export interface InviteDto {
  id: string
  email: string
  role: string
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

  async function create(email: string, role: InviteRole): Promise<InviteCreateResultDto> {
    return $api.post<InviteCreateResultDto>(base, { email, role })
  }

  async function resend(id: string): Promise<InviteResendResultDto> {
    return $api.post<InviteResendResultDto>(base + apiPath`/${id}/resend`)
  }

  async function cancel(id: string): Promise<void> {
    await $api.delete(base + apiPath`/${id}`)
  }

  return { invites, load, create, resend, cancel }
}
