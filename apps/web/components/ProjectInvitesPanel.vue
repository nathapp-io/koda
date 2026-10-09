<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { useProjectInvites } from '~/composables/useProjectInvites'
import type { InviteDto, InviteRole } from '~/composables/useProjectInvites'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ 'member-added': [] }>()

const { t } = useI18n()
const toast = useAppToast()
const { invites, load, create, resend, cancel } = useProjectInvites(props.slug)

/** AGENT is not an invitable role, so the select lists only these three. */
const inviteRoles: InviteRole[] = ['ADMIN', 'DEVELOPER', 'VIEWER']

const email = ref('')
const role = ref<InviteRole>('DEVELOPER')
const submitting = ref(false)
/** Set only on INVITED or a resend: the one-time raw-token link (D526). */
const shareLink = ref<string | null>(null)
const emailed = ref<boolean | null>(null)

function withOrigin(path: string): string {
  return `${window.location.origin}${path}`
}

async function onCreate(): Promise<void> {
  const address = email.value.trim()
  if (!address) return
  submitting.value = true
  try {
    const result = await create(address, role.value)
    if (result.outcome === 'ADDED') {
      emit('member-added')
      await load()
      return
    }
    shareLink.value = result.invitePath ? withOrigin(result.invitePath) : null
    emailed.value = result.emailed ?? null
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    submitting.value = false
  }
}

async function onResend(invite: InviteDto): Promise<void> {
  try {
    const result = await resend(invite.id)
    shareLink.value = withOrigin(result.invitePath)
    emailed.value = result.emailed
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function onCancel(invite: InviteDto): Promise<void> {
  if (!window.confirm(t('projects.invites.cancelConfirm', { email: invite.email }))) return
  try {
    await cancel(invite.id)
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(load)
</script>

<template>
  <div class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('projects.invites.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.invites.subtitle') }}</p>
    </div>

    <form data-testid="invite-create-form" class="flex flex-wrap gap-2" @submit.prevent="onCreate">
      <Input
        id="email"
        name="email"
        v-model="email"
        type="email"
        class="max-w-xs"
        :placeholder="t('projects.invites.emailPlaceholder')"
      />
      <!-- A native select cannot use v-model here (its directive needs a real DOM
           element); the explicit value/change pair is the same protocol. The
           update:model-value listener keeps the control drivable in mount tests. -->
      <select
        id="role"
        name="role"
        :value="role"
        class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        @change="role = ($event.target as HTMLSelectElement).value as InviteRole"
        @update:model-value="role = $event as InviteRole"
      >
        <option v-for="option in inviteRoles" :key="option" :value="option">
          {{ t(`projects.invites.roles.${option}`) }}
        </option>
      </select>
      <Button type="submit" :disabled="submitting">
        {{ submitting ? t('common.loading') : t('projects.invites.send') }}
      </Button>
    </form>

    <div v-if="shareLink" class="space-y-1">
      <p class="text-sm font-medium">{{ t('projects.invites.shareTitle') }}</p>
      <code data-testid="invite-link" class="block break-all rounded bg-muted px-2 py-1 text-sm">{{ shareLink }}</code>
      <p v-if="emailed === false" class="text-sm text-muted-foreground">{{ t('projects.invites.notEmailed') }}</p>
    </div>

    <p v-if="invites.length === 0" class="text-sm text-muted-foreground">{{ t('projects.invites.empty') }}</p>
    <ul v-else class="divide-y divide-border">
      <li v-for="invite in invites" :key="invite.id" class="flex items-center justify-between gap-4 py-2">
        <div>
          <div class="text-sm font-medium">{{ invite.email }}</div>
          <div class="text-xs text-muted-foreground">{{ t(`projects.invites.roles.${invite.role}`) }}</div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            :data-testid="`invite-resend-${invite.id}`"
            @click="onResend(invite)"
          >
            {{ t('projects.invites.resend') }}
          </Button>
          <Button
            size="sm"
            variant="outline"
            :data-testid="`invite-cancel-${invite.id}`"
            @click="onCancel(invite)"
          >
            {{ t('projects.invites.cancel') }}
          </Button>
        </div>
      </li>
    </ul>
  </div>
</template>
