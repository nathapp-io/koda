<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { ASSIGNABLE_MEMBER_ROLES, canManageMembers } from '~/composables/useProjectMembers'
import type { AssignableMemberRole, ProjectMember } from '~/composables/useProjectMembers'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { user } = useAuth()
const { members, total, hasNext, load, loadMore, add, changeRole, remove } = useProjectMembers(props.slug)

const loading = ref(true)
const newEmail = ref('')
const newRole = ref<AssignableMemberRole>('DEVELOPER')
const adding = ref(false)

const canManage = computed(() => canManageMembers(user.value, members.value))

async function run(action: () => Promise<void>, successKey?: string): Promise<boolean> {
  try {
    await action()
    if (successKey) toast.success(t(successKey))
    return true
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    return false
  }
}

async function onAdd(): Promise<void> {
  const email = newEmail.value.trim()
  if (!email) return
  adding.value = true
  if (await run(() => add(email, newRole.value), 'projects.members.toast.added')) newEmail.value = ''
  adding.value = false
}

async function onRoleChange(member: ProjectMember, role: AssignableMemberRole): Promise<void> {
  if (role === member.role) return
  const ok = await run(() => changeRole(member.userId, role), 'projects.members.toast.roleChanged')
  if (!ok) await run(load)
}

async function onRemove(member: ProjectMember): Promise<void> {
  if (!window.confirm(t('projects.members.removeConfirm', { email: member.email }))) return
  await run(() => remove(member.userId), 'projects.members.toast.removed')
}

onMounted(async () => {
  await run(load)
  loading.value = false
})
</script>

<template>
  <div class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('projects.members.title') }} <span class="text-sm text-muted-foreground">({{ total }})</span></h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.members.subtitle') }}</p>
    </div>

    <form v-if="canManage" class="flex flex-wrap gap-2" @submit.prevent="onAdd">
      <Input v-model="newEmail" type="email" class="max-w-xs" :placeholder="t('projects.members.addEmail')" />
      <select v-model="newRole" class="h-9 rounded-md border border-input bg-background px-2 text-sm">
        <option v-for="role in ASSIGNABLE_MEMBER_ROLES" :key="role" :value="role">{{ t(`projects.members.roles.${role}`) }}</option>
      </select>
      <Button type="submit" :disabled="adding">{{ adding ? t('common.loading') : t('projects.members.add') }}</Button>
    </form>

    <LoadingState v-if="loading" />
    <p v-else-if="members.length === 0" class="text-sm text-muted-foreground">{{ t('projects.members.empty') }}</p>
    <ul v-else class="divide-y divide-border">
      <li v-for="member in members" :key="member.userId" class="flex items-center justify-between gap-4 py-2">
        <div>
          <div class="text-sm font-medium">{{ member.name || member.email }}</div>
          <div class="text-xs text-muted-foreground">{{ member.email }}</div>
        </div>
        <div class="flex items-center gap-2">
          <select
            v-if="canManage"
            :value="member.role"
            class="h-8 rounded-md border border-input bg-background px-2 text-sm"
            @change="onRoleChange(member, ($event.target as HTMLSelectElement).value as AssignableMemberRole)"
          >
            <option v-for="role in ASSIGNABLE_MEMBER_ROLES" :key="role" :value="role">{{ t(`projects.members.roles.${role}`) }}</option>
          </select>
          <span v-else class="text-sm">{{ t(`projects.members.roles.${member.role}`) }}</span>
          <Button v-if="canManage" size="sm" variant="outline" @click="onRemove(member)">{{ t('projects.members.remove') }}</Button>
        </div>
      </li>
    </ul>

    <Button v-if="hasNext" variant="outline" size="sm" @click="run(loadMore)">{{ t('projects.members.loadMore') }}</Button>
  </div>
</template>
