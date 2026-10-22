<script setup lang="ts">
import { computed } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'
import { useProjectAgents, type ProjectAgent } from '~/composables/useProjectAgents'

definePageMeta({ layout: 'default' })

const AGENT_STATUSES = ['ACTIVE', 'PAUSED', 'OFFLINE'] as const
const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const agents = useProjectAgents(slug)
const pending = agents.pending
const error = agents.error
const refresh = agents.refresh
const items = agents.items
const scoping = agents.scoping
const { permissions: globalPermissions } = useGlobalPermissions()
const canUpdateAgentStatus = computed(() => globalPermissions.value.has('agent.update'))
const busySlug = ref<string | null>(null)
void refresh()
const isEmptyComputed = computed(() => items.value.length === 0)
const AGENT_STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-status-done', PAUSED: 'bg-status-review', OFFLINE: 'bg-status-todo',
}
function agentStatusDot(status: string) { return AGENT_STATUS_DOT[status] ?? 'bg-muted-foreground' }
function apiErrorMessage(err: unknown): string {
  return extractApiError(err)
}
async function changeStatus(agent: ProjectAgent, status: string, select?: HTMLSelectElement): Promise<void> {
  if (status === agent.status || busySlug.value) return
  busySlug.value = agent.slug
  try {
    await agents.changeStatus(agent.slug, status)
    await refresh()
  } catch (caught) {
    toast.error(apiErrorMessage(caught))
    if (select) select.value = agent.status
    await refresh()
  } finally { busySlug.value = null }
}
function onStatusChange(agent: ProjectAgent, event: Event): void {
  void changeStatus(agent, (event.target as HTMLSelectElement).value, event.target as HTMLSelectElement)
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('agents.title')" />
    <div v-if="!scoping" class="rounded-md border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground" data-testid="project-agents-scoping-off">
      {{ t('agents.project.scopingOff') }}
    </div>
    <LoadingState v-if="pending && items.length === 0" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="isEmptyComputed" :message="t('agents.project.empty')" />
    <Table v-else>
      <TableHeader><TableRow>
        <TableHead>{{ t('agents.columns.name') }}</TableHead>
        <TableHead>{{ t('agents.columns.slug') }}</TableHead>
        <TableHead>{{ t('agents.columns.roles') }}</TableHead>
        <TableHead>{{ t('agents.columns.capabilities') }}</TableHead>
        <TableHead>{{ t('agents.columns.status') }}</TableHead>
        <TableHead>{{ t('agents.columns.openTickets') }}</TableHead>
        <TableHead v-if="canUpdateAgentStatus">{{ t('agents.columns.actions') }}</TableHead>
      </TableRow></TableHeader>
      <TableBody><TableRow v-for="agent in items" :key="agent.slug">
        <TableCell>{{ agent.name }}</TableCell><TableCell>{{ agent.slug }}</TableCell>
        <TableCell><div class="flex flex-wrap gap-1"><Badge v-for="role in agent.roles" :key="role" variant="outline" class="text-xs">{{ role }}</Badge></div></TableCell>
        <TableCell><div class="flex flex-wrap gap-1"><Badge v-for="cap in agent.capabilities" :key="cap" variant="outline" class="text-xs">{{ cap }}</Badge></div></TableCell>
        <TableCell><span :class="TICKET_CHIP_CLASS"><span :class="[TICKET_DOT_CLASS, agentStatusDot(agent.status)]" aria-hidden="true"></span>{{ t(`agents.status.${agent.status}`) }}</span></TableCell>
        <TableCell><span class="text-sm tabular-nums">{{ agent.openTicketCount }}</span></TableCell>
        <TableCell v-if="canUpdateAgentStatus"><select :value="agent.status" :aria-label="t('agents.columns.status')" :disabled="busySlug === agent.slug" class="h-8 rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50" @change="onStatusChange(agent, $event)"><option v-for="status in AGENT_STATUSES" :key="status" :value="status">{{ t(`agents.status.${status}`) }}</option></select></TableCell>
      </TableRow></TableBody>
    </Table>
  </div>
</template>
