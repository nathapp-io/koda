<script setup lang="ts">
import { computed, ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'
import { extractApiError } from '~/composables/useApi'
import { useProjectAgents, type ProjectAgent } from '~/composables/useProjectAgents'

definePageMeta({ layout: 'default' })

const AGENT_STATUSES = ['ACTIVE', 'PAUSED', 'OFFLINE'] as const

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()

const agents = useProjectAgents(slug)
// `useProjectViewerRole` returns the `useAsyncData` envelope
// `{ data, pending, error, refresh }`; `readViewer` unwraps its `data` value.
const viewerRoleRaw = useProjectViewerRole(slug)
const pending = agents.pending
const error = agents.error
const refresh = agents.refresh
const items = agents.items
const scoping = agents.scoping

const addDialogOpen = ref(false)
const addErrorMessage = ref<string | null>(null)
// The agent whose removal was refused for open tickets, and the refs that
// block it. The links render only under that agent's row.
const blockedAgentSlug = ref<string | null>(null)
const blockedTicketRefs = ref<string[]>([])

// Starts the roster load without awaiting it. The page renders its loading
// state until the load resolves, so SSR serializes the loading state and the
// client fills the table. add/remove/status changes reload it the same way.
void refresh()

function resolveViewer(canManageValue: unknown, viewerRoleValue: unknown): { canManage: boolean; viewerRole: string | null } {
  if (typeof canManageValue === 'boolean') {
    return { canManage: canManageValue, viewerRole: typeof viewerRoleValue === 'string' ? viewerRoleValue : null }
  }
  return { canManage: false, viewerRole: typeof viewerRoleValue === 'string' ? viewerRoleValue : null }
}

// `data` starts at the default `{ canManage: false, viewerRole: null }` and
// updates when the SSR/CSR fetch resolves. A global ADMIN gets `canManage:
// true` even on projects they do not directly belong to.
function readViewer(): { canManage: boolean; viewerRole: string | null } {
  if (!viewerRoleRaw) return { canManage: false, viewerRole: null }
  const dataField = (viewerRoleRaw as { data?: { value?: { canManage?: boolean; viewerRole?: string | null } } }).data
  if (dataField && typeof dataField === 'object' && 'value' in dataField) {
    const inner = dataField.value
    return resolveViewer(inner?.canManage, inner?.viewerRole)
  }
  return { canManage: false, viewerRole: null }
}

const canManageComputed = computed(() => {
  const resolved = readViewer()
  return resolved.canManage || resolved.viewerRole === 'ADMIN'
})
const isEmptyComputed = computed(
  () => Array.isArray(items.value) && items.value.length === 0,
)

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
  blockedAgentSlug.value = null
  blockedTicketRefs.value = []
  addErrorMessage.value = null
  addDialogOpen.value = true
}

function setAddDialogOpen(open: boolean): void {
  addDialogOpen.value = open
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
    // The dialog shows the message inline. Reopen it explicitly: it can close
    // itself when it emits `added`, and a failed add must leave it open so the
    // caller can correct the input and retry.
    addErrorMessage.value = apiErrorMessage(caught)
    addDialogOpen.value = true
  }
}

async function changeStatus(agent: ProjectAgent, status: string): Promise<void> {
  if (status === agent.status) return
  try {
    await agents.changeStatus(agent.slug, status)
    await refresh()
  } catch (caught) {
    toast.error(apiErrorMessage(caught))
    await refresh()
  }
}

function onStatusChange(agent: ProjectAgent, event: Event): void {
  void changeStatus(agent, (event.target as HTMLSelectElement).value)
}

async function removeAgent(agent: ProjectAgent): Promise<void> {
  blockedAgentSlug.value = null
  blockedTicketRefs.value = []
  if (agent.openTicketCount > 0) {
    blockedAgentSlug.value = agent.slug
    blockedTicketRefs.value = (agent.openTicketRefs ?? []).filter(
      (entry: string) => typeof entry === 'string' && entry.length > 0,
    )
    return
  }
  // The test sandbox supplies its own `confirm`; on the client, fall back
  // to the native dialog. The global lookup avoids touching `window` when
  // the test sandbox has no `window` global at all.
  const globalConfirm = (globalThis as { confirm?: (msg?: string) => boolean }).confirm
  // With no confirm available the removal is refused: a destructive action never
  // proceeds without an explicit confirmation.
  const confirmFn: (msg: string) => boolean = typeof globalConfirm === 'function'
    ? (msg: string) => Boolean(globalConfirm(msg))
    : (typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm.bind(window)
      : () => false)
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
      v-if="!scoping"
      class="rounded-md border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground"
      data-testid="project-agents-scoping-off"
    >
      {{ t('agents.project.scopingOff') }}
    </div>

    <LoadingState v-if="pending && items.length === 0" />
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
          <TableHead v-if="canManageComputed">{{ t('agents.columns.addedBy') }}</TableHead>
          <TableHead v-if="canManageComputed">{{ t('agents.columns.addedAt') }}</TableHead>
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
                :key="role"
                variant="outline"
                class="text-xs"
              >
                {{ role }}
              </Badge>
            </div>
          </TableCell>
          <TableCell>
            <div class="flex flex-wrap gap-1">
              <Badge
                v-for="cap in agent.capabilities"
                :key="cap"
                variant="outline"
                class="text-xs"
              >
                {{ cap }}
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
          </TableCell>
          <TableCell v-if="canManageComputed">
            <span class="text-sm">{{ agent.addedBy?.name ?? '' }}</span>
          </TableCell>
          <TableCell v-if="canManageComputed">
            <span class="text-sm tabular-nums">{{ agent.addedAt ? agent.addedAt.slice(0, 10) : '' }}</span>
          </TableCell>
          <TableCell v-if="canManageComputed">
            <div class="flex flex-col gap-1">
              <select
                :value="agent.status"
                :aria-label="t('agents.columns.status')"
                class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                @change="onStatusChange(agent, $event)"
              >
                <option v-for="status in AGENT_STATUSES" :key="status" :value="status">
                  {{ t(`agents.status.${status}`) }}
                </option>
              </select>
              <Button variant="ghost" size="sm" @click="removeAgent(agent)">
                {{ t('agents.removeProjectAgent.remove') }}
              </Button>
              <div v-if="blockedAgentSlug === agent.slug" class="flex flex-col gap-0.5">
                <p
                  class="text-xs text-muted-foreground"
                  data-testid="project-agents-blocked-message"
                >
                  {{ t('agents.project.reassignFirst', { count: agent.openTicketCount }) }}
                </p>
                <NuxtLink
                  v-for="ref in blockedTicketRefs"
                  :key="ref"
                  :to="apiPath`/${slug}/tickets/${ref}`"
                  class="text-xs text-primary hover:underline"
                >
                  {{ ref }}
                </NuxtLink>
              </div>
            </div>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <AddProjectAgentDialog
      v-if="canManageComputed"
      :open="addDialogOpen"
      @update:open="setAddDialogOpen"
      :roster="items"
      :error="addErrorMessage"
      @added="(agentSlug: string) => addAgent(agentSlug)"
    />
  </div>
</template>
