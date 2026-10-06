<script setup lang="ts">
import { apiPath } from '~/lib/api-path'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS, statusDotClass } from '~/lib/ticket-chips'

definePageMeta({ layout: 'default' })

interface Agent {
  id: string
  name: string
  slug: string
  roles: (string | { role: string })[]
  capabilities: (string | { capability: string })[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

// The API returns roles/capabilities as entry objects ({ role }, { capability });
// older mocks/tests may still use plain strings. Normalize for display only.
function roleLabel(role: string | { role: string }) {
  return typeof role === 'string' ? role : role.role
}

function capabilityLabel(capability: string | { capability: string }) {
  return typeof capability === 'string' ? capability : capability.capability
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const { data: agentsData, pending, error, refresh } = useAsyncData(
  `agents-${slug}`,
  () => $api.get(apiPath`/projects/${slug}/agents`) as Promise<Agent[]>,
)

const agents = computed(() => agentsData.value ?? [])

// Agent states reuse the ticket status dot tokens: ACTIVE is green (done),
// PAUSED is amber (review), OFFLINE is muted (todo). The i18n label always
// travels with the dot — state is never color alone.
const AGENT_STATUS_TOKEN: Record<string, string> = {
  ACTIVE: 'done',
  PAUSED: 'review',
  OFFLINE: 'todo',
}

function agentStatusDot(status: string) {
  return statusDotClass(AGENT_STATUS_TOKEN[status] ?? '')
}

async function changeStatus(agent: Agent, newStatus: 'ACTIVE' | 'PAUSED' | 'OFFLINE') {
  try {
    await $api.patch(apiPath`/projects/${slug}/agents/${agent.slug}`, { status: newStatus })
    toast.success(t('agents.toast.statusUpdated', { status: newStatus }))
    refresh()
  } catch {
    toast.error(t('agents.toast.statusFailed'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('agents.title')" />

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <EmptyState v-else-if="agents.length === 0" :message="t('agents.empty')" />
    <Table v-else>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('agents.columns.name') }}</TableHead>
          <TableHead>{{ t('agents.columns.slug') }}</TableHead>
          <TableHead>{{ t('agents.columns.roles') }}</TableHead>
          <TableHead>{{ t('agents.columns.capabilities') }}</TableHead>
          <TableHead>{{ t('agents.columns.status') }}</TableHead>
          <TableHead>{{ t('agents.columns.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="agent in agents" :key="agent.id">
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
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="sm">{{ t('common.changeStatus') }}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem @click="changeStatus(agent, 'ACTIVE')">
                  {{ t('agents.status.ACTIVE') }}
                </DropdownMenuItem>
                <DropdownMenuItem @click="changeStatus(agent, 'PAUSED')">
                  {{ t('agents.status.PAUSED') }}
                </DropdownMenuItem>
                <DropdownMenuItem @click="changeStatus(agent, 'OFFLINE')">
                  {{ t('agents.status.OFFLINE') }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>
