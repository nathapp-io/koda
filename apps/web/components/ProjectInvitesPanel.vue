<script setup lang="ts">
/**
 * Permissions P1 US-014: project invites carry a project role key.
 *
 * The panel's four controls have four independent gates, all read from the project key set — never
 * from a role name, because roles are data and a custom role has to work:
 * - the panel itself (and so the invite list) only with `invite.read`;
 * - the create form only with `invite.create`;
 * - each row's resend only with `invite.resend`, cancel only with `invite.cancel`.
 *
 * The role select lists the project's roles (`GET /projects/:slug/roles`, one fetch shared with the
 * members panel) and posts the chosen key as `{ email, roleKey }`; each row shows the invite's
 * `roleName` as the API resolved it. Nothing is preselected: an invite must never grant a role the
 * caller did not pick.
 *
 * A gate only hides or disables: every refusal still comes back from the API and is toasted with
 * `extractApiError`, leaving the last loaded list on screen and the form's values in place.
 */
import { extractApiError } from '~/composables/useApi'
import { useProjectInvites } from '~/composables/useProjectInvites'
import type { InviteDto } from '~/composables/useProjectInvites'
import type { Ref } from 'vue'

const props = defineProps<{ slug: string }>()
const emit = defineEmits<{ 'member-added': [] }>()

const { t } = useI18n()
const toast = useAppToast()
const { permissions } = useProjectPermissions(props.slug)
const { invites, load, create, resend, cancel } = useProjectInvites(props.slug)
const { roles, load: loadRoles } = useProjectRoles(props.slug)

const canRead = computed(() => permissions.value.has('invite.read'))
const canCreate = computed(() => permissions.value.has('invite.create'))
const canResend = computed(() => permissions.value.has('invite.resend'))
const canCancel = computed(() => permissions.value.has('invite.cancel'))

const email = ref('')
const roleKey = ref('')
const submitting = ref(false)
/** Set only on INVITED or a resend: the one-time raw-token link (D526). */
const shareLink = ref<string | null>(null)
const emailed = ref<boolean | null>(null)

function withOrigin(path: string): string {
  return `${window.location.origin}${path}`
}

/** Run one API call, toasting its refusal with the API's own message. */
async function run(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action()
    return true
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
    return false
  }
}

/**
 * The keys arrive asynchronously (`/me/permissions`), so the reads hang off the gates instead of
 * mounting, and a gate that opens after mount (a client navigation resolves the key set late) reads
 * too. Without `invite.read` the list would only earn a 403 toast, and the role select cannot open
 * before `invite.create` renders the form.
 *
 * Both reads stay client-side on purpose: `useProjectInvites` holds the list in a plain ref, so a
 * server-side read would render rows that hydration cannot reproduce (the payload carries the
 * permission keys, not the invites) — an empty list on the client is the mismatch-free render.
 */
function readWhen(gate: Ref<boolean>, read: () => Promise<unknown>): void {
  onMounted(() => { if (gate.value) void run(read) })
  watch(gate, (allowed) => { if (allowed) void run(read) })
}

readWhen(canRead, load)
readWhen(canCreate, loadRoles)

async function onCreate(): Promise<void> {
  const address = email.value.trim()
  const key = roleKey.value
  // No role chosen means no request: the API would refuse a role-less invite anyway.
  if (!address || !key || submitting.value) return
  submitting.value = true
  try {
    const result = await create(address, key)
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
  if (!(await run(() => cancel(invite.id)))) return
  await run(load)
}
</script>

<template>
  <div v-if="canRead" class="rounded-md border border-border p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('projects.invites.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.invites.subtitle') }}</p>
    </div>

    <form v-if="canCreate" data-testid="invite-create-form" class="flex flex-wrap gap-2" @submit.prevent="onCreate">
      <Input
        id="email"
        name="email"
        v-model="email"
        data-testid="invite-email"
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
        data-testid="invite-role"
        :aria-label="t('projects.invites.roleLabel')"
        :value="roleKey"
        class="h-9 rounded-md border border-input bg-background px-2 text-sm"
        @change="roleKey = ($event.target as HTMLSelectElement).value"
        @update:model-value="roleKey = $event as string"
      >
        <option value="">{{ t('projects.invites.selectRole') }}</option>
        <option v-for="role in roles" :key="role.id" :value="role.key">{{ role.name }}</option>
      </select>
      <Button type="submit" :disabled="submitting || !roleKey">
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
      <li v-for="invite in invites" :key="invite.id" data-testid="invite-row" class="flex items-center justify-between gap-4 py-2">
        <div>
          <div class="text-sm font-medium">{{ invite.email }}</div>
          <div v-if="invite.roleName" data-testid="invite-row-role" class="text-xs text-muted-foreground">
            {{ invite.roleName }}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            v-if="canResend"
            size="sm"
            variant="outline"
            :data-testid="`invite-resend-${invite.id}`"
            @click="onResend(invite)"
          >
            {{ t('projects.invites.resend') }}
          </Button>
          <Button
            v-if="canCancel"
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
