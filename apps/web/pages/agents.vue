<script setup lang="ts">
import EditAgentRolesDialog from '~/components/EditAgentRolesDialog.vue'
import EditAgentCapabilitiesDialog from '~/components/EditAgentCapabilitiesDialog.vue'
import RotateKeyDialog from '~/components/RotateKeyDialog.vue'
import DeleteAgentDialog from '~/components/DeleteAgentDialog.vue'

definePageMeta({ layout: 'default' })

interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const { data: agentsData, pending, error, refresh } = useAsyncData(
  'agents',
  () => $api.get('/agents') as Promise<Agent[]>,
)

const agents = computed(() => agentsData.value ?? [])

const isCreateDialogOpen = ref(false)

// Dialog state for Edit Roles
const isRolesDialogOpen = ref(false)
const rolesDialogAgent = ref<Agent | null>(null)

// Dialog state for Edit Capabilities
const isCapabilitiesDialogOpen = ref(false)
const capabilitiesDialogAgent = ref<Agent | null>(null)

// Dialog state for Rotate Key
const isRotateDialogOpen = ref(false)
const rotateDialogAgent = ref<Agent | null>(null)

// Dialog state for Delete Agent
const isDeleteDialogOpen = ref(false)
const deleteDialogAgent = ref<Agent | null>(null)

function openRolesDialog(agent: Agent) {
  rolesDialogAgent.value = agent
  isRolesDialogOpen.value = true
}

function openCapabilitiesDialog(agent: Agent) {
  capabilitiesDialogAgent.value = agent
  isCapabilitiesDialogOpen.value = true
}

function openRotateKeyDialog(agent: Agent) {
  rotateDialogAgent.value = agent
  isRotateDialogOpen.value = true
}

function openDeleteDialog(agent: Agent) {
  deleteDialogAgent.value = agent
  isDeleteDialogOpen.value = true
}

function handleRolesUpdated() {
  refresh()
  isRolesDialogOpen.value = false
}

function handleCapabilitiesUpdated() {
  refresh()
  isCapabilitiesDialogOpen.value = false
}

function handleRotated() {
  refresh()
  isRotateDialogOpen.value = false
}

function handleDeleted() {
  refresh()
  isDeleteDialogOpen.value = false
}

function statusClass(status: string) {
  if (status === 'ACTIVE') return 'bg-green-100 text-green-800'
  if (status === 'PAUSED') return 'bg-yellow-100 text-yellow-800'
  return ''
}

async function changeStatus(agent: Agent, newStatus: 'ACTIVE' | 'PAUSED' | 'OFFLINE') {
  try {
    await $api.patch(`/agents/${agent.slug}`, { status: newStatus })
    toast.success(t('agents.toast.statusUpdated', { status: newStatus }))
    refresh()
  } catch {
    toast.error(t('agents.toast.statusFailed'))
  }
}

function handleAgentCreated() {
  refresh()
  isCreateDialogOpen.value = false
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('agents.title')">
      <template #actions>
        <Dialog :open="isCreateDialogOpen" @update:open="isCreateDialogOpen = $event">
          <DialogTrigger as-child>
            <Button>{{ t('agents.createAgent') }}</Button>
          </DialogTrigger>
          <CreateAgentDialog :open="isCreateDialogOpen" @created="handleAgentCreated" />
        </Dialog>
      </template>
    </PageHeader>

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
                <DropdownMenuItem @click="openRotateKeyDialog(agent)">
                  {{ t('agents.actions.rotateKey') }}
                </DropdownMenuItem>
                <DropdownMenuItem @click="openDeleteDialog(agent)">
                  {{ t('agents.actions.delete') }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem @click="openRolesDialog(agent)">
                  {{ t('agents.actions.editRoles') }}
                </DropdownMenuItem>
                <DropdownMenuItem @click="openCapabilitiesDialog(agent)">
                  {{ t('agents.actions.editCapabilities') }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
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

    <EditAgentRolesDialog
      v-if="rolesDialogAgent"
      :open="isRolesDialogOpen"
      :agent="rolesDialogAgent"
      @update:open="isRolesDialogOpen = $event"
      @updated="handleRolesUpdated"
    />

    <EditAgentCapabilitiesDialog
      v-if="capabilitiesDialogAgent"
      :open="isCapabilitiesDialogOpen"
      :agent="capabilitiesDialogAgent"
      @update:open="isCapabilitiesDialogOpen = $event"
      @updated="handleCapabilitiesUpdated"
    />

    <RotateKeyDialog
      v-if="rotateDialogAgent"
      :open="isRotateDialogOpen"
      :agent="rotateDialogAgent"
      @update:open="isRotateDialogOpen = $event"
      @rotated="handleRotated"
    />

    <DeleteAgentDialog
      v-if="deleteDialogAgent"
      :open="isDeleteDialogOpen"
      :agent="deleteDialogAgent"
      @update:open="isDeleteDialogOpen = $event"
      @deleted="handleDeleted"
    />
  </div>
</template>
