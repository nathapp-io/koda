<script setup lang="ts">
import { UserPlus } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import type { AdminUser, GlobalRole } from '~/composables/useAdminUsers'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { user: currentUser } = useAuth()
const { users, page, hasNext, pending, load, setDisabled, setRole } = useAdminUsers()

const emailFilter = ref('')
const createOpen = ref(false)
const adminOnly = ref(false)

// ApiError.code is the envelope `ret`, not the HTTP status: a 403 from
// @RequiredPermission / ForbiddenAppException arrives as ret 40003.
// (pages/admin/slos.vue checks only 403, which never matches; do not copy it.)
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

function isSelf(user: AdminUser): boolean {
  return user.id === currentUser.value?.id
}

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

async function toggleDisabled(user: AdminUser): Promise<void> {
  try {
    await setDisabled(user.id, !user.disabled)
    toast.success(t(user.disabled ? 'admin.users.toast.enabled' : 'admin.users.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function changeRole(user: AdminUser, role: GlobalRole): Promise<void> {
  if (role === user.role) return
  try {
    await setRole(user.id, role)
    toast.success(t('admin.users.toast.roleChanged'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    await reload(page.value)
  }
}

onMounted(() => reload())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('admin.users.title')" :subtitle="t('admin.users.subtitle')">
      <template #actions>
        <Button :disabled="adminOnly" @click="createOpen = true">
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
            <TableHead>{{ t('admin.users.table.role') }}</TableHead>
            <TableHead>{{ t('admin.users.table.status') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in users" :key="user.id">
            <TableCell>
              {{ user.email }}
              <span v-if="isSelf(user)" class="ml-1 text-xs text-muted-foreground">({{ t('admin.users.you') }})</span>
            </TableCell>
            <TableCell>{{ user.name }}</TableCell>
            <TableCell>
              <select
                :value="user.role"
                :disabled="isSelf(user)"
                class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                @change="changeRole(user, ($event.target as HTMLSelectElement).value as GlobalRole)"
              >
                <option value="MEMBER">{{ t('admin.users.roles.MEMBER') }}</option>
                <option value="ADMIN">{{ t('admin.users.roles.ADMIN') }}</option>
              </select>
            </TableCell>
            <TableCell>{{ user.disabled ? t('admin.users.status.disabled') : t('admin.users.status.active') }}</TableCell>
            <TableCell class="text-right">
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

    <CreateUserDialog v-model:open="createOpen" @created="reload(page)" />
  </div>
</template>
