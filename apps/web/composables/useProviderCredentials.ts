/**
 * C10 US-012: the provider-credential store shared by the GLOBAL admin page and, in US-013, a
 * project's provider-keys card.
 *
 * One instance owns one scope: the GLOBAL list (`/fleet/provider-credentials`) or a project's
 * (`/projects/:slug/provider-credentials`). Nothing here is a global singleton, so the two scopes
 * never share a row list — the project card can hold PROJECT and REPO rows beside the admin page's
 * GLOBAL ones without either seeing the other's.
 *
 * Every write is approval-gated on the API: a call may answer the saved metadata or an
 * `ApprovalRequestSummary` (202). The two are told apart by the `permissionKey` marker, the same way
 * `useFleetRepos` does, and a pending answer never becomes a row — the request is not a saved change.
 */
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetPage } from '~/lib/fleet-types'
import type { ApprovalRequestSummary } from '~/lib/approval-requests'

/** One row of a management list as `ProviderCredentialDto` answers it: metadata only, never the key. */
export interface ProviderCredentialRow {
  id: string
  scope: 'GLOBAL' | 'PROJECT' | 'REPO'
  projectId: string | null
  repoId: string | null
  providerId: string
  name: string
  last4: string
  /** 12 hex characters: a stable, non-reversible identifier of the key. */
  fingerprint: string
  disabled: boolean
  createdBy: string
  updatedAt: string
}

/** The scope an instance reads and writes. A project's slug is required for the project form. */
export type ProviderCredentialsScope = { kind: 'global' } | { kind: 'project'; slug: string }

/** The add body. `repoId` is the project form's optional REPO override (US-013). */
export interface ProviderCredentialInput {
  providerId: string
  name: string
  key: string
  repoId?: string
}

export type ProviderCredentialWrite =
  | { kind: 'saved'; credential: ProviderCredentialRow }
  | { kind: 'pending'; request: ApprovalRequestSummary }

export type ProviderCredentialRemoval =
  | { kind: 'deleted' }
  | { kind: 'pending'; request: ApprovalRequestSummary }

/** The API answers an approval request with the summary, which is the only shape carrying a permission key. */
function isPendingAnswer(data: unknown): data is ApprovalRequestSummary {
  return data !== null && typeof data === 'object' && 'permissionKey' in data
}

function listPath(scope: ProviderCredentialsScope): string {
  return scope.kind === 'global' ? '/fleet/provider-credentials' : apiPath`/projects/${scope.slug}/provider-credentials`
}

/** One credential under the scope's list path; the id is one path segment, never a second segment. */
function itemPath(scope: ProviderCredentialsScope, id: string): string {
  return `${listPath(scope)}/${encodeURIComponent(id)}`
}

export function useProviderCredentials(scope: ProviderCredentialsScope = { kind: 'global' }) {
  const { $api } = useApi()
  const credentials = ref<ProviderCredentialRow[]>([])
  const hasMore = ref(false)
  const pending = ref(false)

  /** Never swallows: the caller decides what a failed read means (the page shows its 403 note). */
  async function load(): Promise<void> {
    pending.value = true
    try {
      const page = await $api.get<FleetPage<ProviderCredentialRow>>(listPath(scope), { query: { size: String(FLEET_LIST_SIZE) } })
      credentials.value = page.records ?? []
      hasMore.value = page.hasNext === true
    } finally {
      pending.value = false
    }
  }

  async function create(input: ProviderCredentialInput): Promise<ProviderCredentialWrite> {
    const body: Record<string, unknown> = { providerId: input.providerId, name: input.name, key: input.key }
    if (input.repoId !== undefined) body.repoId = input.repoId
    const data = await $api.post<ProviderCredentialRow | ApprovalRequestSummary>(listPath(scope), body)
    if (isPendingAnswer(data)) return { kind: 'pending', request: data }
    credentials.value = [...credentials.value, data]
    return { kind: 'saved', credential: data }
  }

  /** Rotation carries the new key and nothing else: the provider id and scope are the row's. */
  async function rotate(id: string, input: { key: string }): Promise<ProviderCredentialWrite> {
    const data = await $api.patch<ProviderCredentialRow | ApprovalRequestSummary>(itemPath(scope, id), { key: input.key })
    if (isPendingAnswer(data)) return { kind: 'pending', request: data }
    replaceRow(data)
    return { kind: 'saved', credential: data }
  }

  /** Disable and enable are one patch with the flag the caller wants, not a toggle the API guesses. */
  async function setDisabled(id: string, disabled: boolean): Promise<ProviderCredentialWrite> {
    const data = await $api.patch<ProviderCredentialRow | ApprovalRequestSummary>(itemPath(scope, id), { disabled })
    if (isPendingAnswer(data)) return { kind: 'pending', request: data }
    replaceRow(data)
    return { kind: 'saved', credential: data }
  }

  async function remove(id: string): Promise<ProviderCredentialRemoval> {
    const data = await $api.delete<{ deleted?: boolean } | ApprovalRequestSummary>(itemPath(scope, id))
    if (isPendingAnswer(data)) return { kind: 'pending', request: data }
    credentials.value = credentials.value.filter((row) => row.id !== id)
    return { kind: 'deleted' }
  }

  function replaceRow(row: ProviderCredentialRow): void {
    credentials.value = credentials.value.map((existing) => (existing.id === row.id ? row : existing))
  }

  return { credentials, hasMore, pending, load, create, rotate, setDisabled, remove }
}
