<script setup lang="ts">
import type { Ref } from 'vue'
import CreateAgentDialog from '~/components/CreateAgentDialog.vue'
import PrincipalRolesDialog from '~/components/PrincipalRolesDialog.vue'
import EditAgentCapabilitiesDialog from '~/components/EditAgentCapabilitiesDialog.vue'
import RotateKeyDialog from '~/components/RotateKeyDialog.vue'
import DeleteAgentDialog from '~/components/DeleteAgentDialog.vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'
import { bindingChips, chipLabel } from '~/lib/role-bindings'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS } from '~/lib/ticket-chips'
import type { BindingChip } from '~/lib/role-bindings'
import type { Role } from '~/composables/useRoles'
import type { RoleBinding } from '~/composables/useRoleBindings'

definePageMeta({ layout: 'default' })

interface AgentRow {
  id: string
  name: string
  slug: string
  roles: (string | { role: string })[]
  capabilities: (string | { capability: string })[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

// The API returns roles/capabilities as entry objects ({ role }, { capability });
// older mocks/tests may still use plain strings. Normalize once at fetch so the
// table and the edit dialogs all work with plain strings.
function roleLabel(role: string | { role: string }) {
  return typeof role === 'string' ? role : role.role
}

function capabilityLabel(capability: string | { capability: string }) {
  return typeof capability === 'string' ? capability : capability.capability
}

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()
const { permissions } = useGlobalPermissions()
const { load: loadRoles } = useRoles()
const { listGlobal } = useRoleBindings()

const { data: agentsData, pending, error, refresh } = useAsyncData(
  'agents',
  () => $api.get('/agents') as Promise<AgentRow[]>,
)

const agents = computed<Agent[]>(() =>
  (agentsData.value ?? []).map((agent) => ({
    ...agent,
    roles: agent.roles.map(roleLabel),
    capabilities: agent.capabilities.map(capabilityLabel),
  })),
)

/**
 * US-012: every control on this page is gated on the global key its API route requires. Roles are
 * data now (`agent.roles` is the legacy field, still on the wire until US-015), so the roles column
 * and "Edit roles" ask the binding routes' own keys. A gate only hides a control: the API still
 * refuses a write, and every refusal is toasted with `extractApiError`.
 */
const can = (key: string): boolean => permissions.value.has(key)

const canCreateAgent = computed(() => can('agent.create'))
const canUpdateStatus = computed(() => can('agent.update'))
const canUpdateCapabilities = computed(() => can('agent.capabilities.update'))
const canRotateKey = computed(() => can('agent.key.rotate'))
const canDeleteAgent = computed(() => can('agent.delete'))
const canManageRoles = computed(() => can('role.read') && can('role.binding.global'))

/** Whether the row's actions menu has anything in it at all (an empty menu is not a control). */
const hasRowActions = computed(() =>
  canManageRoles.value || canUpdateStatus.value || canUpdateCapabilities.value
  || canRotateKey.value || canDeleteAgent.value)

/** The role-editing half of the menu (roles, capabilities), which is also where its dividers go. */
const showsRoleActions = computed(() => canManageRoles.value || canUpdateCapabilities.value)

const isCreateDialogOpen = ref(false)

// Dialog state for Edit Roles (the shared principal-roles dialog)
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

const rolesError = ref('')
const bindingsError = ref('')

/**
 * The page's own copy of the two listings the column joins. Kept here — rather than reading the
 * composables' refs — because publication has to be gated on the newest reload: a composable assigns
 * its records as soon as its own request settles, which would let an older, slower reload overwrite
 * the snapshot a newer one already published (see `reloadRoleData`).
 */
const roles = ref<Role[]>([])
const globalBindings = ref<RoleBinding[]>([])

/** The column shows one load error, whichever of the two listings failed. */
const roleColumnError = computed(() => rolesError.value || bindingsError.value)

/** One agent's project-less bindings: what the dialog edits and what the column's chips show. */
function globalBindingsFor(agent: Agent): RoleBinding[] {
  return globalBindings.value.filter((binding) =>
    binding.principalType === 'AGENT' && binding.principalId === agent.id && binding.projectId === null)
}

/** The chips for every listed row, joined once per (agents, bindings, roles) change, not per render. */
const chipsByAgent = computed(() => {
  const joined = new Map<string, BindingChip[]>()
  for (const agent of agents.value) joined.set(agent.id, bindingChips(globalBindingsFor(agent), roles.value))
  return joined
})

function chipsFor(agent: Agent): BindingChip[] {
  return chipsByAgent.value.get(agent.id) ?? []
}

const rolesPrincipal = computed(() => ({
  type: 'AGENT' as const,
  id: rolesDialogAgent.value?.id ?? '',
  label: rolesDialogAgent.value?.name || rolesDialogAgent.value?.slug || '',
}))

const rolesDialogBindings = computed(() =>
  (rolesDialogAgent.value ? globalBindingsFor(rolesDialogAgent.value) : []))

/**
 * The two listings the column joins, re-read together. Every run carries a generation and only the
 * newest one publishes — records *and* failures. Overlapping runs are reachable in normal use (two
 * binding writes landing one after the other, reopening the dialog on a failed snapshot, a key
 * refresh), and without the gate an older answer decides the snapshot: an older rejection landing
 * last re-blocks a column a newer run already filled, and an older success rewinds the chips.
 *
 * A failure is recorded and toasted the moment it lands rather than when the pair settles: one
 * listing can hang, and until then the page would keep publishing a snapshot it already knows is
 * broken. A run that is no longer the newest publishes nothing at all — neither data nor errors.
 */
let roleDataGeneration = 0
async function reloadRoleData(): Promise<void> {
  if (!canManageRoles.value) return
  const generation = ++roleDataGeneration
  const isLatest = (): boolean => generation === roleDataGeneration
  const onFailure = (target: Ref<string>) => (err: unknown): void => {
    if (!isLatest()) return
    target.value = extractApiError(err)
    toast.error(extractApiError(err))
  }
  await Promise.all([
    loadRoles().then((records) => {
      if (!isLatest()) return
      roles.value = records
      rolesError.value = ''
    }, onFailure(rolesError)),
    listGlobal('AGENT').then((records) => {
      if (!isLatest()) return
      globalBindings.value = records
      bindingsError.value = ''
    }, onFailure(bindingsError)),
  ])
}

// The keys are their own request, so they can land after the agent list: the watch — not the mount —
// is what loads the role data, so the column and "Edit roles" fill in whenever the keys arrive.
watch(canManageRoles, (allowed) => {
  if (allowed) void reloadRoleData()
}, { immediate: true })

/**
 * True while the page cannot vouch for the role snapshot: the keys are unknown (pending or failed) or
 * the last listing attempt failed. The dialog hides its chips and offers no write in this state.
 */
const roleDataBlocked = computed(() => !canManageRoles.value || roleColumnError.value !== '')

function openRolesDialog(agent: Agent) {
  rolesDialogAgent.value = agent
  isRolesDialogOpen.value = true
  // Opening the dialog on an invalid snapshot is the admin's natural retry.
  if (roleColumnError.value !== '') void reloadRoleData()
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

const AGENT_STATUSES = ['ACTIVE', 'PAUSED', 'OFFLINE'] as const

async function changeStatus(agent: Agent, newStatus: 'ACTIVE' | 'PAUSED' | 'OFFLINE') {
  try {
    await $api.patch(apiPath`/agents/${agent.slug}`, { status: newStatus })
    toast.success(t('agents.toast.statusUpdated', { status: newStatus }))
    refresh()
  } catch (err: unknown) {
    // The API owns the rules (who may update an agent, and what a status change needs); show what it said.
    toast.error(extractApiError(err))
  }
}

/**
 * US-012 (fix round 1, F1): `POST /agents` also binds the agent's baseline role
 * (`MembershipService.bindBaseline` — the global `agent` role) inside the create transaction, so the
 * binding listing has to be re-read too. Without it the new row would claim "No roles" and its
 * dialog would offer the role it already holds.
 */
async function handleAgentCreated() {
  await Promise.all([refresh(), reloadRoleData()])
  isCreateDialogOpen.value = false
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('agents.title')">
      <template #actions>
        <Dialog v-if="canCreateAgent" :open="isCreateDialogOpen" @update:open="isCreateDialogOpen = $event">
          <DialogTrigger as-child>
            <Button data-testid="agent-create">{{ t('agents.createAgent') }}</Button>
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
          <TableHead v-if="canManageRoles">{{ t('agents.columns.roles') }}</TableHead>
          <TableHead>{{ t('agents.columns.capabilities') }}</TableHead>
          <TableHead>{{ t('agents.columns.status') }}</TableHead>
          <TableHead>{{ t('agents.columns.actions') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="agent in agents" :key="agent.id" data-testid="agent-row" :data-agent="agent.id">
          <TableCell>{{ agent.name }}</TableCell>
          <TableCell>{{ agent.slug }}</TableCell>
          <TableCell v-if="canManageRoles" data-testid="agent-roles-cell">
            <span v-if="roleColumnError" class="text-sm text-status-rejected" data-testid="agent-roles-error">
              {{ roleColumnError }}
            </span>
            <div v-else-if="chipsFor(agent).length > 0" class="flex flex-wrap gap-1">
              <Badge
                v-for="chip in chipsFor(agent)"
                :key="chip.id"
                variant="outline"
                class="text-xs"
                data-testid="agent-role-chip"
                :data-role="chip.roleKey"
              >
                {{ chipLabel(chip, t) }}
              </Badge>
            </div>
            <span v-else class="text-xs text-muted-foreground" data-testid="agent-roles-empty">
              {{ t('agents.noRoles') }}
            </span>
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
            <DropdownMenu v-if="hasRowActions">
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="sm" data-testid="agent-actions">{{ t('agents.actions.menu') }}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem v-if="canRotateKey" data-testid="agent-rotate-key" @click="openRotateKeyDialog(agent)">
                  {{ t('agents.actions.rotateKey') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="canDeleteAgent" data-testid="agent-delete" @click="openDeleteDialog(agent)">
                  {{ t('agents.actions.delete') }}
                </DropdownMenuItem>
                <DropdownMenuSeparator v-if="showsRoleActions && (canRotateKey || canDeleteAgent)" />
                <DropdownMenuItem v-if="canManageRoles" data-testid="agent-edit-roles" @click="openRolesDialog(agent)">
                  {{ t('agents.actions.editRoles') }}
                </DropdownMenuItem>
                <DropdownMenuItem v-if="canUpdateCapabilities" data-testid="agent-edit-capabilities" @click="openCapabilitiesDialog(agent)">
                  {{ t('agents.actions.editCapabilities') }}
                </DropdownMenuItem>
                <template v-if="canUpdateStatus">
                  <DropdownMenuSeparator v-if="showsRoleActions || canRotateKey || canDeleteAgent" />
                  <DropdownMenuItem
                    v-for="status in AGENT_STATUSES"
                    :key="status"
                    :data-testid="`agent-status-${status}`"
                    @click="changeStatus(agent, status)"
                  >
                    {{ t(`agents.status.${status}`) }}
                  </DropdownMenuItem>
                </template>
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <PrincipalRolesDialog
      v-if="rolesDialogAgent"
      v-model:open="isRolesDialogOpen"
      :principal="rolesPrincipal"
      :bindings="rolesDialogBindings"
      :roles="roles"
      :load-error="roleColumnError"
      :blocked="roleDataBlocked"
      @changed="reloadRoleData"
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
