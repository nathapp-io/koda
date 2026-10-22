<script setup lang="ts">
import { Pencil, UserPlus } from 'lucide-vue-next'
import PrincipalRolesDialog from '~/components/PrincipalRolesDialog.vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { bindingChips, chipLabel } from '~/lib/role-bindings'
import type { BindingChip } from '~/lib/role-bindings'
import type { AdminUser } from '~/composables/useAdminUsers'
import type { RoleBinding } from '~/composables/useRoleBindings'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { user: currentUser } = useAuth()
const { users, page, hasNext, pending, load, setDisabled } = useAdminUsers()
const { permissions } = useGlobalPermissions()
const { roles, load: loadRoles } = useRoles()
const { bindings, listGlobal } = useRoleBindings()

// US-011: roles are data now, so the column and "Edit roles" ask for the keys the binding routes
// need. A gate only hides a control; the API still refuses a write and the refusal is toasted.
const canManageRoles = computed(() =>
  permissions.value.has('role.read') && permissions.value.has('role.binding.global'))

const emailFilter = ref('')
const createOpen = ref(false)
const adminOnly = ref(false)
const rolesError = ref('')
const bindingsError = ref('')
const rolesDialogOpen = ref(false)
const editing = ref<AdminUser | null>(null)

/** The column shows one load error, whichever of the two listings failed. */
const roleColumnError = computed(() => rolesError.value || bindingsError.value)

// ApiError.code is the envelope `ret`, not the HTTP status: a 403 from
// @RequiredPermission / ForbiddenAppException arrives as ret 40003.
// (pages/admin/slos.vue checks only 403, which never matches; do not copy it.)
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

function isSelf(user: AdminUser): boolean {
  return user.id === currentUser.value?.id
}

function canEditRoles(user: AdminUser): boolean {
  return canManageRoles.value && !isSelf(user)
}

/** One user's project-less bindings: what the dialog edits and what the column's chips show. */
function globalBindingsFor(user: AdminUser): RoleBinding[] {
  return bindings.value.filter((binding) =>
    binding.principalType === 'USER' && binding.principalId === user.id && binding.projectId === null)
}

/** The chips for every listed row, joined once per (users, bindings, roles) change, not per render. */
const chipsByUser = computed(() => {
  const joined = new Map<string, BindingChip[]>()
  for (const user of users.value) joined.set(user.id, bindingChips(globalBindingsFor(user), roles.value))
  return joined
})

function chipsFor(user: AdminUser): BindingChip[] {
  return chipsByUser.value.get(user.id) ?? []
}

const editingPrincipal = computed(() => ({
  type: 'USER' as const,
  id: editing.value?.id ?? '',
  label: editing.value?.name || editing.value?.email || '',
}))

const editingBindings = computed(() => (editing.value ? globalBindingsFor(editing.value) : []))

async function reload(targetPage = 1): Promise<void> {
  adminOnly.value = false
  try {
    await load({ email: emailFilter.value, page: targetPage })
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
}

/**
 * The roles and the bindings the column joins. Both are read together and each failure is kept
 * separately: an unjoined chip would show a key where a name belongs, so a failure renders the load
 * error instead of chips — and the dialog, which shows the same rows, is told about it too.
 *
 * The error state is only decided by a completed attempt, and only a run in which both listings
 * succeeded clears it. Clearing it when a request *starts* (or when the permission gate flickers)
 * would re-publish the stale snapshot the failure was about.
 */
async function reloadRoleData(): Promise<void> {
  if (!canManageRoles.value || adminOnly.value) return
  const [rolesFailure, bindingsFailure] = await Promise.all([
    loadRoles().then(() => null, (err: unknown) => extractApiError(err)),
    listGlobal('USER').then(() => null, (err: unknown) => extractApiError(err)),
  ])
  if (rolesFailure !== null) {
    rolesError.value = rolesFailure
    toast.error(rolesFailure)
  }
  if (bindingsFailure !== null) {
    bindingsError.value = bindingsFailure
    toast.error(bindingsFailure)
  }
  if (rolesFailure === null && bindingsFailure === null) {
    rolesError.value = ''
    bindingsError.value = ''
  }
}

/**
 * The permission keys are their own request, so they can land after the users list. The watch — not
 * the mount — is what loads the role data, so the column and "Edit roles" fill in whenever the two
 * keys become available.
 *
 * Losing the keys deliberately does *not* clear the load errors: they describe the snapshot, and a
 * permission refresh is not a reload. The dialog reads the same state, so a failed snapshot stays
 * closed instead of reopening with raw role keys while the keys are re-read.
 */
watch(canManageRoles, (allowed) => {
  if (allowed) void reloadRoleData()
}, { immediate: true })

/**
 * True while the page cannot vouch for the role snapshot: the keys are unknown (pending or failed) or
 * the last listing attempt failed. The dialog hides its chips and offers no write in this state.
 */
const roleDataBlocked = computed(() => !canManageRoles.value || roleColumnError.value !== '')

function openRoles(user: AdminUser): void {
  editing.value = user
  rolesDialogOpen.value = true
}

/** A created account gets a baseline binding from the API, so the chips need a fresh read too. */
async function onUserCreated(): Promise<void> {
  await Promise.all([reload(page.value), reloadRoleData()])
}

async function toggleDisabled(user: AdminUser): Promise<void> {
  try {
    await setDisabled(user.id, !user.disabled)
    toast.success(t(user.disabled ? 'admin.users.toast.enabled' : 'admin.users.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('admin.users.title')" :subtitle="t('admin.users.subtitle')">
      <template #actions>
        <Button :disabled="adminOnly" data-testid="user-create" @click="createOpen = true">
          <UserPlus class="mr-2 h-4 w-4" />{{ t('admin.users.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('admin.users.adminOnly') }}</p>

    <template v-else>
      <form class="flex max-w-md gap-2" @submit.prevent="reload()">
        <Input v-model="emailFilter" :placeholder="t('admin.users.filterPlaceholder')" />
        <Button type="submit" variant="outline">{{ t('admin.users.filter') }}</Button>
      </form>

      <LoadingState v-if="pending && users.length === 0" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('admin.users.table.email') }}</TableHead>
            <TableHead>{{ t('admin.users.table.name') }}</TableHead>
            <TableHead v-if="canManageRoles">{{ t('admin.users.table.role') }}</TableHead>
            <TableHead>{{ t('admin.users.table.status') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in users" :key="user.id" data-testid="user-row" :data-user="user.id">
            <TableCell>
              {{ user.email }}
              <span v-if="isSelf(user)" class="ml-1 text-xs text-muted-foreground">({{ t('admin.users.you') }})</span>
            </TableCell>
            <TableCell>{{ user.name }}</TableCell>
            <TableCell v-if="canManageRoles" data-testid="user-roles-cell">
              <span v-if="roleColumnError" class="text-sm text-status-rejected" data-testid="user-roles-error">
                {{ roleColumnError }}
              </span>
              <template v-else-if="chipsFor(user).length > 0">
                <Badge
                  v-for="chip in chipsFor(user)"
                  :key="chip.id"
                  variant="secondary"
                  class="mr-1"
                  data-testid="user-role-chip"
                  :data-role="chip.roleKey"
                >{{ chipLabel(chip, t) }}</Badge>
              </template>
              <span v-else class="text-xs text-muted-foreground" data-testid="user-roles-empty">
                {{ t('admin.users.noRoles') }}
              </span>
            </TableCell>
            <TableCell>{{ user.disabled ? t('admin.users.status.disabled') : t('admin.users.status.active') }}</TableCell>
            <TableCell class="space-x-2 text-right">
              <Button
                v-if="canEditRoles(user)"
                size="sm"
                variant="outline"
                data-testid="user-edit-roles"
                @click="openRoles(user)"
              >
                <Pencil class="mr-1 h-3.5 w-3.5" />{{ t('admin.users.editRoles') }}
              </Button>
              <Button size="sm" variant="outline" :disabled="isSelf(user)" @click="toggleDisabled(user)">
                {{ user.disabled ? t('admin.users.enable') : t('admin.users.disable') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div class="flex gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" @click="reload(page - 1)">{{ t('admin.users.prev') }}</Button>
        <Button variant="outline" size="sm" :disabled="!hasNext" @click="reload(page + 1)">{{ t('admin.users.next') }}</Button>
      </div>
    </template>

    <PrincipalRolesDialog
      v-model:open="rolesDialogOpen"
      :principal="editingPrincipal"
      :bindings="editingBindings"
      :roles="roles"
      :load-error="roleColumnError"
      :blocked="roleDataBlocked"
      @changed="reloadRoleData"
    />
    <CreateUserDialog v-model:open="createOpen" @created="onUserCreated" />
  </div>
</template>
