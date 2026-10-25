import { ref } from 'vue'
import { auditApiQuery, type AuditActorType, type AuditFilters } from '~/lib/audit-log'

/** A principal as the API names it in an entry (id only — the name is in `display`). */
export interface AuditPrincipal {
  type: AuditActorType
  id: string
}

/** Who a decomposed action was performed for. */
export interface AuditOnBehalfOf {
  type: Exclude<AuditActorType, 'RUNNER' | 'SYSTEM'>
  id: string
}

/** How the write was authorized: the mode it required and what satisfied it. */
export interface AuditApproval {
  requiredMode: string
  satisfiedBy: string
  approverType: Exclude<AuditActorType, 'RUNNER' | 'SYSTEM'> | null
  approverId: string | null
  requestId: string | null
}

/** How the write entered the system. */
export type AuditOrigin = 'rest' | 'mcp' | 'thread' | 'runner' | 'system'

/**
 * Resolved labels for one entry (US-001): the audit row stores ids only, and these are the names a
 * human reads. A null actor is a SYSTEM component, which the page shows through `principalLabel`.
 */
export interface AuditDisplay {
  actor: string | null
  onBehalfOf: string | null
  approver: string | null
  project: { slug: string; name: string } | null
}

/** One row of `GET /audit` (`AuditEntryDto`). */
export interface AuditEntry {
  id: string
  key: string
  resourceType: string
  resourceId: string
  projectId: string | null
  actor: AuditPrincipal
  onBehalfOf: AuditOnBehalfOf | null
  origin: AuditOrigin
  approval: AuditApproval
  correlationId: string
  summary: string | null
  display: AuditDisplay
  /** ISO instant. */
  createdAt: string
}

/** The page envelope `GET /audit` returns (`toPageResult`). */
export interface AuditPage {
  records: AuditEntry[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

export interface AuditKeysResponse {
  keys: string[]
}

/**
 * The audit page's only API surface. A failed load rethrows and leaves the last good page in place
 * (the `useAdminUsers` pattern), so a transient 500 or a 403 after a permission change never empties
 * the table the reader is studying.
 */
export function useAuditLog() {
  const { $api } = useApi()
  const entries = ref<AuditEntry[]>([])
  const total = ref(0)
  const hasNext = ref(false)
  const pending = ref(false)
  const keys = ref<string[]>([])

  async function load(filters: AuditFilters): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<AuditPage>('/audit', { query: auditApiQuery(filters) })
      entries.value = res.records ?? []
      total.value = res.total ?? 0
      hasNext.value = res.hasNext === true
    }
    finally {
      pending.value = false
    }
  }

  async function loadKeys(): Promise<void> {
    pending.value = true
    try {
      const res = await $api.get<AuditKeysResponse>('/audit/keys')
      keys.value = res.keys ?? []
    }
    finally {
      pending.value = false
    }
  }

  return { entries, total, hasNext, pending, keys, load, loadKeys }
}
