<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const { data: agentsData, pending, error, refresh } = useAsyncData(
  `agents-${slug}`,
  () => $api.get(`/projects/${slug}/agents`) as Promise<Agent[]>,
)

const agents = computed(() => agentsData.value ?? [])

function statusClass(status: string) {
  if (status === 'ACTIVE') return 'bg-green-100 text-green-800'
  if (status === 'PAUSED') return 'bg-yellow-100 text-yellow-800'
  return ''
}

async function changeStatus(agent: Agent, newStatus: 'ACTIVE' | 'PAUSED' | 'OFFLINE') {
  try {
    await $api.patch(`/projects/${slug}/agents/${agent.id}`, { status: newStatus })
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
            <Badge
              :variant="agent.status === 'OFFLINE' ? 'secondary' : 'outline'"
              :class="statusClass(agent.status)"
            >
              {{ t(`agents.status.${agent.status}`) }}
            </Badge>
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
