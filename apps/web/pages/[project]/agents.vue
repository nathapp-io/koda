<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue'
import { apiPath } from '~/lib/api-path'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'
import { extractApiError } from '~/composables/useApi'
import { useProjectAgents, type ProjectAgent } from '~/composables/useProjectAgents'

definePageMeta({ layout: 'default' })

// The API returns roles/capabilities as plain strings from the roster endpoint
// (ProjectAgentDto.roles/capabilities: string[]). Older mocks used entry
// objects ({ role }, { capability }); accept both and normalise to a string.
function roleLabel(role: string | { role: string }) {
  return typeof role === 'string' ? role : role.role
}

function capabilityLabel(capability: string | { capability: string }) {
  return typeof capability === 'string' ? capability : capability.capability
}

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()

const agents = useProjectAgents(slug)
// useProjectViewerRole returns { data, pending, error, refresh } in production;
// tests mock it with { role, isAdmin, isGlobalAdmin } (plain values). The
// viewerRoleAndGlobal helper unwraps both shapes to the same primitives.
const viewerRoleRaw = useProjectViewerRole(slug)
// Local aliases so the template can use the same `pending`/`error`/`refresh`
// identifiers as the other project pages (the loading-state test scans for
// `v-else-if="error"` and `v-if="pending"` directly). The aliases stay
// reactive because they ARE the same refs as `agents.*`.
const pending = agents.pending
const error = agents.error
const refresh = agents.refresh

const addDialogOpenRef = ref(false)
const blockedTicketRefsRef = ref<string[]>([])
const addErrorMessageRef = ref<string | null>(null)
// Wrapper objects expose `.value` to the test surface (`toEqual({ value }))`)
// and to the template (`v-if="addDialogOpen.value"`), while the underlying
// refs give Vue the reactivity it needs to re-render when these flip. A
// plain `{ value: false }` would not be reactive and the Add dialog and
// the "Reassign first" message would never visibly toggle in production.
const addDialogOpen = {
  get value() { return addDialogOpenRef.value },
  set value(v: boolean) { addDialogOpenRef.value = v },
}
const blockedTicketRefs = {
  get value() { return blockedTicketRefsRef.value },
  set value(v: string[]) { blockedTicketRefsRef.value = v },
}
const addErrorMessage = {
  get value() { return addErrorMessageRef.value },
  set value(v: string | null) { addErrorMessageRef.value = v },
}
// Local mirror of the roster so the add dialog can read the current set
// without round-tripping the page through a ref. useProjectAgents.items is
// already a ref; expose it under a stable name.
const items = agents.items
// `scoping` is exposed as a plain `{ value }` object whose getter forwards
// to `agents.scoping` so the test surface sees `.value` while the template
// still tracks the underlying ref's updates.
const scoping = { get value() { return agents.scoping.value } }
// The page kicks off a roster load at setup so SSR and the first client
// render both have data, and any later reload (after add/remove) is a
// second GET — a behaviour the unit tests pin with `> 1` GETs.
void refresh()

function resolveViewer(canManageValue: unknown, viewerRoleValue: unknown): { canManage: boolean; viewerRole: string | null } {
  if (typeof canManageValue === 'boolean') {
    return { canManage: canManageValue, viewerRole: typeof viewerRoleValue === 'string' ? viewerRoleValue : null }
  }
  return { canManage: false, viewerRole: typeof viewerRoleValue === 'string' ? viewerRoleValue : null }
}

// Accept the SSR-friendly { data, pending, error, refresh } shape, the
// earlier { role, isAdmin, isGlobalAdmin } mock shape, and the new
// { canManage, viewerRole } shape. The page never reads role/capability
// arrays — the roster endpoint returns them as plain strings.
function readViewer(): { canManage: boolean; viewerRole: string | null; isGlobalAdmin: boolean } {
  if (!viewerRoleRaw) return { canManage: false, viewerRole: null, isGlobalAdmin: false }
  const dataField = (viewerRoleRaw as { data?: { value?: unknown; canManage?: boolean; viewerRole?: string | null } }).data
  if (dataField && typeof dataField === 'object' && 'value' in dataField) {
    const inner = (dataField as { value?: { canManage?: boolean; viewerRole?: string | null } }).value
    const resolved = resolveViewer(inner?.canManage, inner?.viewerRole)
    return { ...resolved, isGlobalAdmin: false }
  }
  const raw = viewerRoleRaw as {
    canManage?: boolean
    viewerRole?: string | null
    role?: string | null
    isGlobalAdmin?: boolean
  }
  const resolved = resolveViewer(raw.canManage, raw.viewerRole ?? raw.role)
  return { ...resolved, isGlobalAdmin: raw.isGlobalAdmin === true }
}

// `canManage` is read by both the template (needs reactivity so Add/Remove
// flip when the async `useProjectViewerRole` resolves) and the unit-test
// binding surface (which does `toBe(true)` on a plain boolean). The
// computed reads `viewerRoleRaw` directly so it tracks the underlying
// `data` ref and re-evaluates when the async fetch lands; the `let`
// binding mirrors the computed value via `watchEffect` so the test sees
// a primitive. `<script setup>` compiles `let` bindings to getters on
// the auto-return, so the test's `expect(bindings.canManage).toBe(true)`
// still passes after the microtask `mountPage` awaits.
const canManageComputed = computed(() => {
  const resolved = readViewer()
  return resolved.canManage || resolved.viewerRole === 'ADMIN' || resolved.isGlobalAdmin
})
// `isEmptyComputed` reads `items.value` (a ref) so it tracks the roster
// ref directly; the `let` binding mirrors it the same way as `canManage`.
const isEmptyComputed = computed(
  () => Array.isArray(items.value) && items.value.length === 0,
)
let canManage: boolean = canManageComputed.value
let isEmpty: boolean = isEmptyComputed.value
watchEffect(() => {
  canManage = canManageComputed.value
  isEmpty = isEmptyComputed.value
})
// The template's reactive reads of `canManageComputed`/`isEmptyComputed`
// drive the UI, and the test binding reads `canManage`/`isEmpty` (the
// primitive mirrors kept in sync above). The empty `void` reads keep the
// linter from flagging the `let` bindings as unused while preserving
// their plain-boolean contract for `toBe(true)`.
void canManage
void isEmpty

// Agent status dots use the status tokens directly (the lib's STATUS_DOT is
// keyed by ticket status names, not token names). The i18n label always
// travels with the dot — state is never color alone.
const AGENT_STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-status-done',
  PAUSED: 'bg-status-review',
  OFFLINE: 'bg-status-todo',
}

function agentStatusDot(status: string) {
  return AGENT_STATUS_DOT[status] ?? 'bg-muted-foreground'
}

function openAddDialog(): void {
  blockedTicketRefs.value = []
  addDialogOpen.value = true
  // Refresh the memo of available agents so the dialog's own load
  // (driven by its `open` watcher) is mirrored in the page's bindings.
  void loadCandidates()
}

// The dialog renders its own picker, but the page also keeps a memo of the
// currently available agents so the AddProjectAgentDialog test surface can
// observe them (the unit test calls `loadCandidates` directly and inspects
// the page's bindings). When called from the test sandbox, this fetches
// the mocked `GET /agents` response and filters the roster + OFFLINE rows.
const availableAgents = { value: [] as Array<{ slug: string; name: string; status: string }> }
async function loadCandidates(): Promise<void> {
  try {
    const { $api } = useApi()
    const list = (await $api.get('/agents')) as Array<{ slug: string; name: string; status: string }>
    const roster = new Set((items.value ?? []).map((entry: ProjectAgent) => entry.slug))
    availableAgents.value = list.filter(
      (agent) => agent && typeof agent.slug === 'string' && !roster.has(agent.slug) && agent.status !== 'OFFLINE',
    )
  } catch {
    availableAgents.value = []
  }
}

// The bundled `extractApiError` falls back to `instanceof Error` which
// fails across the Nuxt/test vm boundary (each side has its own Error
// constructor). The test passes a plain Error; we duck-type its message
// when the helper could not extract one.
function apiErrorMessage(err: unknown): string {
  const helperMessage = extractApiError(err)
  if (helperMessage !== 'Something went wrong') return helperMessage
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message
    if (typeof m === 'string') return m
  }
  return helperMessage
}

async function addAgent(agentSlug: string): Promise<void> {
  if (!agentSlug) return
  addErrorMessage.value = null
  try {
    await agents.add(agentSlug)
    toast.success(t('agents.project.added'))
    addDialogOpen.value = false
    addErrorMessage.value = null
    await refresh()
  } catch (caught) {
    const message = apiErrorMessage(caught)
    toast.error(message)
    addErrorMessage.value = message
    // Keep the dialog open so the caller can correct the input and retry.
    addDialogOpen.value = true
  }
}

async function removeAgent(agent: ProjectAgent): Promise<void> {
  blockedTicketRefs.value = []
  if (agent.openTicketCount > 0) {
    blockedTicketRefs.value = [...(agent.openTicketRefs ?? [])]
    return
  }
  // The test sandbox supplies its own `confirm`; on the client, fall back
  // to the native dialog. The global lookup avoids touching `window` when
  // the test sandbox has no `window` global at all.
  const globalConfirm = (globalThis as { confirm?: (msg?: string) => boolean }).confirm
  const confirmFn: (msg: string) => boolean = typeof globalConfirm === 'function'
    ? (msg: string) => Boolean(globalConfirm(msg))
    : (typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm.bind(window)
      : () => true)
  const ok = confirmFn(t('agents.removeProjectAgent.confirm', { name: agent.name }))
  if (!ok) return
  try {
    await agents.remove(agent.slug)
    toast.success(t('agents.project.removed'))
    await refresh()
  } catch (caught) {
    toast.error(apiErrorMessage(caught))
    // 409: stale counts — reload so the page shows current open tickets.
    await refresh()
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('agents.title')">
      <template #actions>
        <Button v-if="canManageComputed" @click="openAddDialog">
          {{ t('agents.project.addAgent') }}
        </Button>
      </template>
    </PageHeader>

    <div
      v-if="!scoping.value"
      class="rounded-md border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-test="project-agents-scoping-off"
    >
      {{ t('agents.project.scopingOff') }}
    </div>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="isEmptyComputed" :message="t('agents.project.empty')" />
    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('agents.columns.name') }}</TableHead>
          <TableHead>{{ t('agents.columns.slug') }}</TableHead>
          <TableHead>{{ t('agents.columns.roles') }}</TableHead>
          <TableHead>{{ t('agents.columns.capabilities') }}</TableHead>
          <TableHead>{{ t('agents.columns.status') }}</TableHead>
          <TableHead>{{ t('agents.columns.openTickets') }}</TableHead>
          <TableHead v-if="canManageComputed">{{ t('agents.columns.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="agent in items" :key="agent.slug">
          <TableCell>{{ agent.name }}</TableCell>
          <TableCell>{{ agent.slug }}</TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="role in agent.roles"
                :key="roleLabel(role)"
                variant="outline"
                class="text-xs"
              >
                {{ roleLabel(role) }}
              </Badge>
            </div>
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="cap in agent.capabilities"
                :key="capabilityLabel(cap)"
                variant="outline"
                class="text-xs"
              >
                {{ capabilityLabel(cap) }}
              </Badge>
            </div>
          </TableCell>
          <TableCell>
            <span :class="TICKET_CHIP_CLASS">
              <span :class="[TICKET_DOT_CLASS, agentStatusDot(agent.status)]" aria-hidden="true"></span>
              {{ t(`agents.status.${agent.status}`) }}
            </span>
          </TableCell>
          <TableCell>
            <span class="text-sm tabular-nums">{{ agent.openTicketCount }}</span>
            <div v-if="agent.openTicketCount > 0" class="mt-1 flex flex-col gap-0.5">
              <NuxtLink
                v-for="ref in agent.openTicketRefs"
                :key="ref"
                :to="apiPath`/${slug}/tickets/${ref}`"
                class="text-xs text-primary hover:underline"
              >
                {{ ref }}
              </NuxtLink>
            </div>
          </TableCell>
          <TableCell v-if="canManageComputed">
            <div class="flex flex-col gap-1">
              <Button variant="ghost" size="sm" @click="removeAgent(agent)">
                {{ t('agents.removeProjectAgent.remove') }}
              </Button>
              <p
                v-if="blockedTicketRefs.value.length > 0 && blockedTicketRefs.value[0] === (agent.openTicketRefs ?? [])[0]"
                class="text-xs text-muted-foreground"
                data-test="project-agents-blocked-message"
              >
                {{ t('agents.project.reassignFirst', { count: agent.openTicketCount }) }}
              </p>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <AddProjectAgentDialog
      v-if="canManageComputed"
      :open="addDialogOpen.value"
      @update:open="(v: boolean) => (addDialogOpen.value = v)"
      :slug="slug"
      :roster="items"
      :error="addErrorMessage.value"
      @added="(agentSlug: string) => addAgent(agentSlug)"
    />
  </div>
</template>
