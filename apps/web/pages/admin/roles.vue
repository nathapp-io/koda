<script setup lang="ts">
import { Pencil, Plus, Trash2 } from 'lucide-vue-next'
import RoleEditorDialog from '~/components/RoleEditorDialog.vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import type { Role } from '~/composables/useRoles'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { roles, pending, load, remove } = useRoles()
const { permissions } = useGlobalPermissions()

// A gate only hides a control; the API still refuses a write and the refusal is toasted.
const canManage = computed(() => permissions.value.has('role.manage'))

const adminOnly = ref(false)
const editorOpen = ref(false)
const editing = ref<Role | null>(null)

// ApiError.code is the envelope `ret`, not the HTTP status: a 403 arrives as ret 40003 (as on
// pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

async function reload(): Promise<void> {
  adminOnly.value = false
  try {
    await load()
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
}

function openCreate(): void {
  editing.value = null
  editorOpen.value = true
}

function openEdit(role: Role): void {
  editing.value = role
  editorOpen.value = true
}

function canDelete(role: Role): boolean {
  return canManage.value && !role.system && !role.locked
}

async function onDelete(role: Role): Promise<void> {
  if (!window.confirm(t('admin.roles.deleteConfirm', { name: role.name }))) return
  try {
    await remove(role.id)
    toast.success(t('admin.roles.toast.deleted'))
  } catch (err: unknown) {
    // The list keeps its last loaded state, so the role stays listed.
    toast.error(extractApiError(err))
    return
  }
  await reload()
}

onMounted(() => reload())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('admin.roles.title')" :subtitle="t('admin.roles.subtitle')">
      <template #actions>
        <Button v-if="canManage && !adminOnly" data-testid="role-create" @click="openCreate">
          <Plus class="mr-2 h-4 w-4" />{{ t('admin.roles.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground" data-testid="roles-admin-only">{{ t('admin.roles.adminOnly') }}</p>

    <template v-else>
      <LoadingState v-if="pending && roles.length === 0" />
      <Table v-else data-testid="roles-table">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('admin.roles.table.name') }}</TableHead>
            <TableHead>{{ t('admin.roles.table.key') }}</TableHead>
            <TableHead>{{ t('admin.roles.table.scope') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="role in roles" :key="role.id" data-testid="role-row" :data-key="role.key">
            <TableCell>
              <span class="mr-2">{{ role.name }}</span>
              <Badge v-if="role.system" variant="secondary" data-testid="role-system-badge">{{ t('admin.roles.badge.system') }}</Badge>
              <Badge v-if="role.locked" variant="outline" class="ml-1" data-testid="role-locked-badge">{{ t('admin.roles.badge.locked') }}</Badge>
            </TableCell>
            <TableCell data-testid="role-key-cell"><code>{{ role.key }}</code></TableCell>
            <TableCell data-testid="role-scope-cell">{{ t(`admin.roles.scope.${role.scope}`) }}</TableCell>
            <TableCell class="text-right">
              <Button v-if="canManage" size="sm" variant="outline" data-testid="role-edit" @click="openEdit(role)">
                <Pencil class="mr-1 h-3.5 w-3.5" />{{ role.locked ? t('admin.roles.view') : t('admin.roles.edit') }}
              </Button>
              <Button v-if="canDelete(role)" size="sm" variant="outline" class="ml-2" data-testid="role-delete" @click="onDelete(role)">
                <Trash2 class="mr-1 h-3.5 w-3.5" />{{ t('admin.roles.delete') }}
              </Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </template>

    <RoleEditorDialog v-model:open="editorOpen" :role="editing" @saved="reload" />
  </div>
</template>
