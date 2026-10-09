<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { ASSIGNABLE_MEMBER_ROLES } from '~/composables/useProjectMembers'
import type { AssignableMemberRole, ProjectMember } from '~/composables/useProjectMembers'

const props = defineProps<{ slug: string }>()

const { t } = useI18n()
const toast = useAppToast()
const { members, total, hasNext, canManage, load, reload, loadMore, add, changeRole, remove } = useProjectMembers(props.slug)

const loading = ref(true)
const newEmail = ref('')
const newRole = ref<AssignableMemberRole>('DEVELOPER')
const adding = ref(false)

/** Legacy AGENT rows are not assignable through this API; render them as a label. */
function isAssignableRole(role: string): role is AssignableMemberRole {
  return (ASSIGNABLE_MEMBER_ROLES as readonly string[]).includes(role)
}

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
  if (!ok) await run(reload)
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
      <div
        role="radiogroup"
        :aria-label="t('projects.members.roleLabel')"
        class="flex h-9 items-center rounded-md border border-input bg-background p-0.5 text-sm"
      >
        <Button
          v-for="role in ASSIGNABLE_MEMBER_ROLES"
          :key="role"
          type="button"
          variant="ghost"
          size="sm"
          :data-role="role"
          :aria-pressed="newRole === role"
          :class="newRole === role ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'"
          @click="newRole = role"
        >
          {{ t(`projects.members.roles.${role}`) }}
        </Button>
      </div>
      <Button type="submit" :disabled="adding">{{ adding ? t('common.loading') : t('projects.members.add') }}</Button>
    </form>

    <LoadingState v-if="loading" />
    <p v-else-if="members.length === 0" class="text-sm text-muted-foreground">{{ t('projects.members.empty') }}</p>
    <ul v-else class="divide-y divide-border">
      <li v-for="member in members" :key="member.userId" class="flex items-center justify-between gap-4 py-2">
        <div>
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{{ member.name || member.email }}</span>
            <span v-if="member.disabled" data-testid="member-disabled-badge" class="inline-flex h-[22px] items-center rounded-full border border-status-rejected/40 bg-status-rejected/10 px-2.5 text-xs font-medium text-status-rejected">
              {{ t('projects.members.disabledBadge') }}
            </span>
          </div>
          <div class="text-xs text-muted-foreground">{{ member.email }}</div>
        </div>
        <div class="flex items-center gap-2">
          <div
            v-if="canManage && !member.disabled && isAssignableRole(member.role)"
            role="radiogroup"
            :aria-label="`${t('projects.members.roleLabel')}: ${member.name || member.email}`"
            class="flex h-8 items-center rounded-md border border-input bg-background p-0.5 text-sm"
          >
            <Button
              v-for="role in ASSIGNABLE_MEMBER_ROLES"
              :key="role"
              type="button"
              variant="ghost"
              size="sm"
              :data-role="role"
              :aria-pressed="member.role === role"
              :class="member.role === role ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'"
              @click="onRoleChange(member, role)"
            >
              {{ t(`projects.members.roles.${role}`) }}
            </Button>
          </div>
          <span v-else class="text-sm">{{ t(`projects.members.roles.${member.role}`) }}</span>
          <Button v-if="canManage" size="sm" variant="outline" @click="onRemove(member)">{{ t('projects.members.remove') }}</Button>
        </div>
      </li>
    </ul>

    <Button v-if="hasNext" variant="outline" size="sm" @click="run(loadMore)">{{ t('projects.members.loadMore') }}</Button>
  </div>
</template>
