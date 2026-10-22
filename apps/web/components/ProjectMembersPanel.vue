<script setup lang="ts">
/**
 * Permissions P1 US-013: the project's members, users and agents in one list with role chips.
 *
 * One row per principal from `GET /projects/:slug/members?principals=all`, one chip per role that
 * principal holds in this project (`roleName`, straight from the API) and the binding writes beside
 * it. A chip whose `id` is null stands for a legacy membership row: it renders, but there is no
 * binding to delete and no way to remove the row.
 *
 * Writes go through the API's own routes — the member add for a user by email, `POST`/`DELETE
 * /role-bindings` for everything else — and the panel never restates a server rule: a refusal is
 * toasted with `extractApiError` and the last loaded rows stay on screen.
 *
 * Gates read the project key set, never a role name: the add-user form needs `member.add`, and the
 * agent picker, the chip add/remove and the row removal need `role.binding.manage`. The caller's own
 * row and a disabled account's row are read-only, because the API refuses both.
 */
import { X } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import type { MemberBinding, ProjectPrincipalRow } from '~/composables/useProjectMembers'

interface AgentChoice {
  id: string
  slug: string
  name: string
}

const props = defineProps<{ slug: string; projectId: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { $api } = useApi()
const { user } = useAuth()
const { permissions } = useProjectPermissions(props.slug)
const { members, total, hasNext, load, reload, loadMore, add } = useProjectMembers(props.slug)
const { roles, load: loadRoles } = useProjectRoles(props.slug)
const { create: createBinding, remove: removeBinding } = useRoleBindings()

const loading = ref(true)
const newEmail = ref('')
const newRoleKey = ref('')
const addingMember = ref(false)
const agentChoices = ref<AgentChoice[]>([])
/** True once the agent picker has answered, so "every agent is listed" is not claimed too early. */
const agentsLoaded = ref(false)
const agentId = ref('')
const agentRoleKey = ref('')
const addingAgent = ref(false)
/** The role picked in a row's "add role" select, per row; one map keeps the select controlled. */
const rowRoleKey = ref<Record<string, string>>({})
/** The row whose write is in flight, so a second click cannot send a second request. */
const busyRow = ref<string | null>(null)

const canAddMember = computed(() => permissions.value.has('member.add'))
const canManageBindings = computed(() => permissions.value.has('role.binding.manage'))

const rowKey = (row: ProjectPrincipalRow): string => `${row.principalType}:${row.principalId}`
const displayName = (row: ProjectPrincipalRow): string =>
  row.name || row.email || row.agentSlug || ''

/** The caller's own account: the API refuses self-binding, so the row offers no write. */
function isSelf(row: ProjectPrincipalRow): boolean {
  const me = user.value?.id ?? null
  return row.principalType === 'USER' && me !== null && row.userId === me
}

function canEditRow(row: ProjectPrincipalRow): boolean {
  return canManageBindings.value && !row.disabled && !isSelf(row)
}

/** A row is removable only when at least one of its bindings is a real (non-legacy) row. */
const hasRemovableBinding = (row: ProjectPrincipalRow): boolean =>
  row.bindings.some((binding) => binding.id !== null)

/** The roles this row does not hold yet: what its "add role" select may offer. */
function rowRoles(row: ProjectPrincipalRow) {
  const held = new Set(row.bindings.map((binding) => binding.roleKey))
  return roles.value.filter((role) => !held.has(role.key))
}

/** The agents this project does not list yet, by id; a listed slug excludes the agent too. */
const offerableAgents = computed(() => {
  const listedIds = new Set(members.value.filter((row) => row.principalType === 'AGENT').map((row) => row.principalId))
  const listedSlugs = new Set(members.value.map((row) => row.agentSlug).filter((slug): slug is string => slug !== null))
  return agentChoices.value.filter((agent) => !listedIds.has(agent.id) && !listedSlugs.has(agent.slug))
})

const chipKey = (row: ProjectPrincipalRow, binding: MemberBinding): string =>
  binding.id ?? `${rowKey(row)}:${binding.roleKey}`

async function run(action: () => Promise<unknown>, successKey?: string): Promise<boolean> {
  try {
    await action()
    if (successKey) toast.success(t(successKey))
    return true
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
    return false
  }
}

/**
 * `GET /agents` minus the agents already listed here. A failed read empties the picker, loudly, and
 * answers false so the caller may offer to retry it.
 */
async function loadAgentChoices(): Promise<boolean> {
  try {
    const res = await $api.get<AgentChoice[]>('/agents')
    agentChoices.value = Array.isArray(res)
      ? res.filter((agent) => typeof agent?.id === 'string' && typeof agent.name === 'string')
      : []
    // Only a successful read may claim "every agent is already a member".
    agentsLoaded.value = true
    return true
  }
  catch (err: unknown) {
    agentChoices.value = []
    toast.error(extractApiError(err))
    return false
  }
}

/**
 * The agent candidates, fetched at most once. The gate below can open more than once (a re-resolved
 * key set), and a page reload is not a reason to ask again.
 */
let agentChoicesRequested = false
async function ensureAgentChoices(): Promise<void> {
  if (agentChoicesRequested) return
  agentChoicesRequested = true
  if (!(await loadAgentChoices())) agentChoicesRequested = false
}

/**
 * The project key set arrives asynchronously: `useProjectPermissions` reads `/me/permissions` in an
 * async data fetch, which on a client navigation resolves after the members and roles pages. The
 * picker is therefore fetched when the gate opens, not once at mount — otherwise the form would
 * appear with an empty, permanently unusable select.
 */
watch(canManageBindings, (allowed) => {
  if (allowed) void ensureAgentChoices()
}, { immediate: true })

async function onAddMember(): Promise<void> {
  const email = newEmail.value.trim()
  const roleKey = newRoleKey.value
  if (!email || !roleKey || addingMember.value) return
  addingMember.value = true
  try {
    await add(email, roleKey)
    newEmail.value = ''
    toast.success(t('projects.members.toast.added'))
  }
  catch (err: unknown) {
    // The form keeps what was typed so the caller can correct it and retry.
    toast.error(extractApiError(err))
  }
  finally {
    addingMember.value = false
  }
}

async function onAddAgent(): Promise<void> {
  const principalId = agentId.value
  const roleKey = agentRoleKey.value
  if (!principalId || !roleKey || addingAgent.value) return
  addingAgent.value = true
  try {
    await createBinding({ principalType: 'AGENT', principalId, roleKey, projectId: props.projectId })
    agentId.value = ''
    toast.success(t('projects.members.toast.agentAdded'))
    // The new agent's chips are the server's answer, so the list is re-read rather than guessed.
    await run(reload)
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    addingAgent.value = false
  }
}

async function onAddChip(row: ProjectPrincipalRow): Promise<void> {
  const key = rowKey(row)
  const roleKey = rowRoleKey.value[key]
  if (!roleKey || busyRow.value !== null) return
  busyRow.value = key
  try {
    await createBinding({ principalType: row.principalType, principalId: row.principalId, roleKey, projectId: props.projectId })
    rowRoleKey.value = { ...rowRoleKey.value, [key]: '' }
    toast.success(t('projects.members.toast.roleAdded'))
    await run(reload)
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    busyRow.value = null
  }
}

async function onRemoveChip(row: ProjectPrincipalRow, binding: MemberBinding): Promise<void> {
  const id = binding.id
  if (id === null || busyRow.value !== null) return
  busyRow.value = rowKey(row)
  try {
    await removeBinding(id)
    toast.success(t('projects.members.toast.roleRemoved'))
    // The chip that goes is not always the only change: deleting a binding can uncover the same-key
    // legacy membership the API was suppressing behind it, and a binding-only principal loses its row
    // with its last binding. Only the server's answer says which, so the list is re-read rather than
    // patched, exactly as a row removal does.
    await run(reload)
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    busyRow.value = null
  }
}

/**
 * Remove a principal by deleting each binding it holds in this project, then re-reading the list.
 * Legacy bindings have no row to delete and are skipped — the legacy `DELETE …/members/:userId` is
 * deliberately not substituted. A refused delete stops the loop and still reloads, so what is on
 * screen is what the server now holds.
 */
async function onRemoveRow(row: ProjectPrincipalRow): Promise<void> {
  const ids = row.bindings
    .map((binding) => binding.id)
    .filter((id): id is string => id !== null)
  if (ids.length === 0 || busyRow.value !== null) return
  const key = rowKey(row)
  if (!window.confirm(t('projects.members.removeConfirm', { name: displayName(row) }))) return
  busyRow.value = key
  let failure: unknown = null
  try {
    for (const id of ids) {
      try {
        await removeBinding(id)
      }
      catch (err: unknown) {
        failure = err
        break
      }
    }
  }
  finally {
    busyRow.value = null
  }
  if (failure) toast.error(extractApiError(failure))
  else toast.success(t('projects.members.toast.removed'))
  await run(reload)
}

onMounted(async () => {
  await run(load)
  loading.value = false
  await run(loadRoles)
})
</script>

<template>
  <div class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">
        {{ t('projects.members.title') }} <span class="text-sm text-muted-foreground">({{ total }})</span>
      </h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.members.subtitle') }}</p>
    </div>

    <form v-if="canAddMember" data-testid="member-add-form" class="flex flex-wrap gap-2" @submit.prevent="onAddMember">
      <Input
        v-model="newEmail"
        data-testid="member-add-email"
        type="email"
        class="max-w-xs"
        :placeholder="t('projects.members.addEmail')"
      />
      <select
        data-testid="member-add-role"
        :aria-label="t('projects.members.roleLabel')"
        :value="newRoleKey"
        class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        @change="newRoleKey = ($event.target as HTMLSelectElement).value"
        @update:model-value="newRoleKey = $event as string"
      >
        <option value="">{{ t('projects.members.selectRole') }}</option>
        <option v-for="role in roles" :key="role.id" :value="role.key">{{ role.name }}</option>
      </select>
      <Button type="submit" data-testid="member-add-submit" :disabled="addingMember || !newRoleKey">
        {{ addingMember ? t('common.loading') : t('projects.members.add') }}
      </Button>
    </form>

    <form v-if="canManageBindings" data-testid="agent-add-form" class="flex flex-wrap gap-2" @submit.prevent="onAddAgent">
      <select
        data-testid="agent-add-select"
        :aria-label="t('projects.members.agentLabel')"
        :value="agentId"
        class="h-9 max-w-xs rounded-md border border-input bg-background px-2 text-sm"
        @change="agentId = ($event.target as HTMLSelectElement).value"
        @update:model-value="agentId = $event as string"
      >
        <option value="">{{ t('projects.members.agentPlaceholder') }}</option>
        <option v-for="agent in offerableAgents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
      </select>
      <select
        data-testid="agent-add-role"
        :aria-label="t('projects.members.roleLabel')"
        :value="agentRoleKey"
        class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        @change="agentRoleKey = ($event.target as HTMLSelectElement).value"
        @update:model-value="agentRoleKey = $event as string"
      >
        <option value="">{{ t('projects.members.selectRole') }}</option>
        <option v-for="role in roles" :key="role.id" :value="role.key">{{ role.name }}</option>
      </select>
      <Button type="submit" data-testid="agent-add-submit" :disabled="addingAgent || agentId === '' || !agentRoleKey">
        {{ addingAgent ? t('common.loading') : t('projects.members.addAgent') }}
      </Button>
    </form>
    <p v-if="canManageBindings && agentsLoaded && offerableAgents.length === 0" class="text-sm text-muted-foreground">
      {{ t('projects.members.noAgents') }}
    </p>

    <LoadingState v-if="loading" />
    <p v-else-if="members.length === 0" class="text-sm text-muted-foreground">{{ t('projects.members.empty') }}</p>
    <ul v-else class="divide-y divide-border">
      <li
        v-for="row in members"
        :key="rowKey(row)"
        data-testid="member-row"
        class="flex items-start justify-between gap-4 py-2"
      >
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <span data-testid="member-name" class="text-sm font-medium">{{ displayName(row) }}</span>
            <span
              v-if="row.principalType === 'AGENT'"
              data-testid="member-agent-badge"
              class="inline-flex h-[22px] items-center rounded-full border border-border bg-muted px-2.5 text-xs font-medium text-muted-foreground"
            >
              {{ t('projects.members.agentBadge') }}
            </span>
            <span v-if="row.principalType === 'AGENT' && row.agentSlug" data-testid="member-agent-slug" class="text-xs text-muted-foreground">
              {{ row.agentSlug }}
            </span>
            <span
              v-if="row.disabled"
              data-testid="member-disabled-badge"
              class="inline-flex h-[22px] items-center rounded-full border border-status-rejected/40 bg-status-rejected/10 px-2.5 text-xs font-medium text-status-rejected"
            >
              {{ t('projects.members.disabledBadge') }}
            </span>
          </div>
          <div v-if="row.principalType === 'USER' && row.email" class="text-xs text-muted-foreground">{{ row.email }}</div>
          <div class="mt-1 flex flex-wrap gap-1">
            <Badge
              v-for="binding in row.bindings"
              :key="chipKey(row, binding)"
              data-testid="member-chip"
              :data-role="binding.roleKey"
              variant="secondary"
              class="gap-1"
            >
              <span>{{ binding.roleName }}</span>
              <button
                v-if="binding.id && canEditRow(row)"
                type="button"
                data-testid="member-chip-remove"
                class="text-muted-foreground hover:text-foreground"
                :disabled="busyRow !== null"
                :aria-label="t('projects.members.removeRole', { name: binding.roleName })"
                @click="onRemoveChip(row, binding)"
              >
                <X class="h-3 w-3" />
              </button>
            </Badge>
          </div>
        </div>
        <div v-if="canEditRow(row)" class="flex flex-wrap items-center gap-2">
          <template v-if="rowRoles(row).length > 0">
            <select
              data-testid="member-chip-add-role"
              :aria-label="t('projects.members.roleLabel')"
              :value="rowRoleKey[rowKey(row)] ?? ''"
              class="h-8 rounded-md border border-input bg-background px-2 text-sm"
              @change="rowRoleKey = { ...rowRoleKey, [rowKey(row)]: ($event.target as HTMLSelectElement).value }"
              @update:model-value="rowRoleKey = { ...rowRoleKey, [rowKey(row)]: $event as string }"
            >
              <option value="">{{ t('projects.members.selectRole') }}</option>
              <option v-for="role in rowRoles(row)" :key="role.id" :value="role.key">{{ role.name }}</option>
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="member-chip-add"
              :disabled="!rowRoleKey[rowKey(row)] || busyRow !== null"
              @click="onAddChip(row)"
            >
              {{ t('projects.members.addRole') }}
            </Button>
          </template>
          <Button
            v-if="hasRemovableBinding(row)"
            type="button"
            size="sm"
            variant="outline"
            data-testid="member-row-remove"
            :disabled="busyRow !== null"
            @click="onRemoveRow(row)"
          >
            {{ t('projects.members.remove') }}
          </Button>
        </div>
      </li>
    </ul>

    <Button v-if="hasNext" data-testid="member-load-more" variant="outline" size="sm" @click="run(loadMore)">
      {{ t('projects.members.loadMore') }}
    </Button>
  </div>
</template>
