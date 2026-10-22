<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent v-if="open" class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t('admin.bindings.title', { name: principal.label }) }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4" data-testid="principal-roles-body">
        <div class="flex flex-wrap gap-2" data-testid="binding-chips">
          <Badge
            v-for="chip in chips"
            :key="chip.id"
            variant="secondary"
            class="gap-1"
            data-testid="binding-chip"
            :data-role="chip.roleKey"
          >
            <span>{{ chipLabel(chip, t) }}</span>
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground"
              data-testid="binding-remove"
              :disabled="removingId !== null"
              :aria-label="t('admin.bindings.remove', { name: chip.name })"
              @click="removeBindingById(chip.id)"
            >
              <X class="h-3 w-3" />
            </button>
          </Badge>
        </div>
        <p v-if="chips.length === 0" class="text-sm text-muted-foreground" data-testid="binding-empty">
          {{ t('admin.bindings.empty') }}
        </p>

        <div class="flex items-end gap-2">
          <label class="flex-1 space-y-1">
            <span class="text-sm font-medium">{{ t('admin.bindings.addRole') }}</span>
            <select
              :value="selectedRoleKey"
              data-testid="binding-role-select"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              @change="selectedRoleKey = ($event.target as HTMLSelectElement).value"
            >
              <option value="">{{ t('admin.bindings.selectRole') }}</option>
              <option v-for="role in offerable" :key="role.id" :value="role.key">{{ role.name }}</option>
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            data-testid="binding-add"
            :disabled="adding || selectedRoleKey === ''"
            @click="addBinding"
          >
            {{ t('admin.bindings.add') }}
          </Button>
        </div>

        <p v-if="offerable.length === 0" class="text-xs text-muted-foreground" data-testid="binding-no-roles">
          {{ t('admin.bindings.noRoles') }}
        </p>

        <div class="flex justify-end">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.done') }}</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * Permissions P1 US-011: the one dialog that grants and removes a principal's global role bindings.
 *
 * Shared by Admin -> Users (US-011) and Admin -> Agents (US-012), so it owns no page state: the
 * bindings it shows and the roles it offers arrive as props (the page reads them from
 * `GET /role-bindings?scope=global` and `GET /roles`), and it answers with `changed` so the page
 * reloads them from the API. The API is the authority on who may grant what — a refusal is toasted
 * and nothing is emitted, which leaves the page (and this dialog) exactly as it was.
 */
import { X } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import { bindableRoles, bindingChips, chipLabel } from '~/lib/role-bindings'
import type { Role } from '~/composables/useRoles'
import type { RoleBinding } from '~/composables/useRoleBindings'

const props = defineProps<{
  open: boolean
  /** Who the bindings belong to; `label` is the display name the title shows. */
  principal: { type: 'USER' | 'AGENT'; id: string; label: string }
  /** That principal's project-less bindings, exactly as `GET /role-bindings?scope=global` returned them. */
  bindings: RoleBinding[]
  /** The roles `GET /roles` returned, joined against each binding's `roleKey`. */
  roles: Role[]
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'changed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create, remove } = useRoleBindings()
const { permissions } = useGlobalPermissions()

const selectedRoleKey = ref('')
const adding = ref(false)
const removingId = ref<string | null>(null)

const chips = computed(() => bindingChips(props.bindings, props.roles))

// The owner role is user-only and needs its own key: an agent can never own, and a caller without
// role.binding.owner cannot grant it (the API refuses either way).
const offerable = computed(() => bindableRoles(props.roles, props.bindings, {
  canGrantOwner: permissions.value.has('role.binding.owner') && props.principal.type === 'USER',
}))

// A different principal keeps nothing from the last one.
watch(() => [props.principal.type, props.principal.id], () => { selectedRoleKey.value = '' })

async function addBinding(): Promise<void> {
  const roleKey = selectedRoleKey.value
  if (!roleKey || adding.value) return
  adding.value = true
  try {
    await create({
      principalType: props.principal.type,
      principalId: props.principal.id,
      roleKey,
      projectId: null,
    })
    selectedRoleKey.value = ''
    toast.success(t('admin.bindings.toast.added'))
    emit('changed')
  } catch (err: unknown) {
    // The dialog stays open and the chips stay as they were; the API's refusal is the message.
    toast.error(extractApiError(err))
  } finally {
    adding.value = false
  }
}

async function removeBindingById(id: string): Promise<void> {
  if (removingId.value !== null) return
  removingId.value = id
  try {
    await remove(id)
    toast.success(t('admin.bindings.toast.removed'))
    emit('changed')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    removingId.value = null
  }
}
</script>
