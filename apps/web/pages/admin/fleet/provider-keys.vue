<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useProviderCredentials } from '~/composables/useProviderCredentials'
import { providerCredentialFormSchema, providerKeySchema } from '~/lib/provider-credentials'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { ProviderCredentialRow } from '~/composables/useProviderCredentials'

definePageMeta({ layout: 'default' })

/**
 * C10 US-012: the GLOBAL provider keys an admin manages. The list is metadata only — a key is
 * write-only after save, so nothing here can reveal one — and every write is approval-gated on the
 * API: a pending answer shows a notice and changes no row.
 *
 * Gates follow the API's own keys, one per action: `fleet.credential.create` for the add form,
 * `.update` for rotate and enable/disable, `.delete` for the delete button. A gate only hides a
 * control; an API refusal is still surfaced through the toast.
 */
const { t } = useI18n()
const toast = useAppToast()
const { credentials, hasMore, pending, load, create, rotate, setDisabled, remove } = useProviderCredentials()

const { permissions } = useGlobalPermissions()
const canCreate = computed(() => permissions.value.has('fleet.credential.create'))
const canUpdate = computed(() => permissions.value.has('fleet.credential.update'))
const canDelete = computed(() => permissions.value.has('fleet.credential.delete'))

const forbidden = ref(false)
/** The approval-pending notice: a write that became a request changes nothing until it is approved. */
const notice = ref('')
const adding = ref(false)
/** The row whose write is in flight, so only its controls are disabled. */
const savingId = ref('')
/** The rotate field per row, and the per-row validation message (a key never leaves the browser). */
const rotateKeys = ref<Record<string, string>>({})
const rotateErrors = ref<Record<string, string>>({})

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/fleet/repos.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

async function reload(): Promise<void> {
  try {
    await load()
  } catch (err: unknown) {
    if (isForbidden(err)) forbidden.value = true
    else toast.error(extractApiError(err))
  }
}

const { handleSubmit, resetForm } = useForm({
  validationSchema: toTypedSchema(providerCredentialFormSchema(t)),
  initialValues: { providerId: '', name: '', key: '' },
})

const onAdd = handleSubmit(async (values) => {
  notice.value = ''
  adding.value = true
  try {
    const result = await create({ providerId: values.providerId, name: values.name, key: values.key })
    if (result.kind === 'pending') {
      notice.value = t('fleet.providerKeys.pending')
      return
    }
    // A saved key leaves nothing to resubmit: the form starts empty again (the key is write-only).
    resetForm({ values: { providerId: '', name: '', key: '' } })
    toast.success(t('fleet.providerKeys.toast.created'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    adding.value = false
  }
})

function setRotateKey(id: string, value: string): void {
  rotateKeys.value = { ...rotateKeys.value, [id]: value }
}

function setRotateError(id: string, message: string): void {
  rotateErrors.value = { ...rotateErrors.value, [id]: message }
}

/** Rotation submits the new key only: the provider id and scope belong to the row being replaced. */
async function onRotate(credential: ProviderCredentialRow): Promise<void> {
  const parsed = providerKeySchema(t).safeParse(rotateKeys.value[credential.id] ?? '')
  if (!parsed.success) {
    setRotateError(credential.id, parsed.error.issues[0]?.message ?? t('fleet.providerKeys.validation.keyLength'))
    return
  }
  setRotateError(credential.id, '')
  notice.value = ''
  savingId.value = credential.id
  try {
    const result = await rotate(credential.id, { key: parsed.data })
    if (result.kind === 'pending') {
      notice.value = t('fleet.providerKeys.pending')
      return
    }
    setRotateKey(credential.id, '')
    toast.success(t('fleet.providerKeys.toast.rotated'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    savingId.value = ''
  }
}

async function onToggle(credential: ProviderCredentialRow): Promise<void> {
  notice.value = ''
  savingId.value = credential.id
  try {
    const wasDisabled = credential.disabled
    const result = await setDisabled(credential.id, !wasDisabled)
    if (result.kind === 'pending') {
      notice.value = t('fleet.providerKeys.pending')
      return
    }
    toast.success(wasDisabled ? t('fleet.providerKeys.toast.enabled') : t('fleet.providerKeys.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    savingId.value = ''
  }
}

async function onDelete(credential: ProviderCredentialRow): Promise<void> {
  if (!window.confirm(t('fleet.providerKeys.deleteConfirm', { provider: credential.providerId }))) return
  notice.value = ''
  savingId.value = credential.id
  try {
    const result = await remove(credential.id)
    if (result.kind === 'pending') {
      notice.value = t('fleet.providerKeys.pending')
      return
    }
    toast.success(t('fleet.providerKeys.toast.deleted'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    savingId.value = ''
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.providerKeys.title')" :subtitle="t('fleet.providerKeys.subtitle')">
      <template #actions>
        <NuxtLink to="/admin/fleet/credentials" class="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-muted" data-testid="provider-keys-board-link">
          {{ t('fleet.credentials.title') }}
        </NuxtLink>
        <Button variant="outline" :disabled="pending || forbidden" data-testid="provider-keys-refresh" @click="reload()">
          {{ t('fleet.providerKeys.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="provider-keys-forbidden">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <p v-if="notice" class="rounded-md border border-border bg-muted px-3 py-2 text-sm" data-testid="provider-keys-notice">{{ notice }}</p>

      <form v-if="canCreate" class="space-y-3 rounded-lg border border-border p-4" data-testid="provider-key-add-form" @submit="onAdd">
        <div class="grid gap-3 sm:grid-cols-3">
          <FormField v-slot="{ componentField }" name="providerId">
            <FormItem>
              <FormLabel>{{ t('fleet.providerKeys.form.providerId') }}</FormLabel>
              <FormControl>
                <Input v-bind="componentField" data-testid="provider-key-add-provider" autocomplete="off" :placeholder="t('fleet.providerKeys.form.providerIdPlaceholder')" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="name">
            <FormItem>
              <FormLabel>{{ t('fleet.providerKeys.form.name') }}</FormLabel>
              <FormControl>
                <Input v-bind="componentField" data-testid="provider-key-add-name" autocomplete="off" :placeholder="t('fleet.providerKeys.form.namePlaceholder')" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
          <FormField v-slot="{ componentField }" name="key">
            <FormItem>
              <FormLabel>{{ t('fleet.providerKeys.form.key') }}</FormLabel>
              <FormControl>
                <Input v-bind="componentField" data-testid="provider-key-add-key" type="password" autocomplete="new-password" :placeholder="t('fleet.providerKeys.form.keyPlaceholder')" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" :disabled="adding" data-testid="provider-key-add-submit">
            {{ adding ? t('fleet.providerKeys.form.saving') : t('fleet.providerKeys.form.submit') }}
          </Button>
          <span class="text-xs text-muted-foreground">{{ t('fleet.providerKeys.form.writeOnly') }}</span>
        </div>
      </form>

      <LoadingState v-if="pending && credentials.length === 0" />
      <EmptyState v-else-if="credentials.length === 0" :message="t('fleet.providerKeys.empty')" />
      <Table v-else data-testid="provider-keys-table">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.providerKeys.table.provider') }}</TableHead>
            <TableHead>{{ t('fleet.providerKeys.table.name') }}</TableHead>
            <TableHead>{{ t('fleet.providerKeys.table.last4') }}</TableHead>
            <TableHead>{{ t('fleet.providerKeys.table.fingerprint') }}</TableHead>
            <TableHead>{{ t('fleet.providerKeys.table.state') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow
            v-for="credential in credentials"
            :key="credential.id"
            :data-testid="`provider-key-${credential.id}`"
            :data-disabled="credential.disabled ? 'true' : 'false'"
          >
            <TableCell class="font-medium">{{ credential.providerId }}</TableCell>
            <TableCell>{{ credential.name }}</TableCell>
            <TableCell class="font-mono text-xs">{{ credential.last4 }}</TableCell>
            <TableCell class="font-mono text-xs">{{ credential.fingerprint }}</TableCell>
            <TableCell>
              <Badge :variant="credential.disabled ? 'outline' : 'secondary'" :data-testid="`provider-key-state-${credential.id}`">
                {{ credential.disabled ? t('fleet.providerKeys.state.disabled') : t('fleet.providerKeys.state.enabled') }}
              </Badge>
            </TableCell>
            <TableCell class="space-y-2 whitespace-nowrap text-right">
              <div v-if="canUpdate" class="flex items-center justify-end gap-2">
                <Input
                  :model-value="rotateKeys[credential.id] ?? ''"
                  type="password"
                  autocomplete="new-password"
                  class="h-8 w-44"
                  :placeholder="t('fleet.providerKeys.form.newKey')"
                  :data-testid="`provider-key-rotate-${credential.id}`"
                  @update:model-value="(value: string | number) => setRotateKey(credential.id, String(value))"
                  @keyup.enter="onRotate(credential)"
                />
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="savingId === credential.id"
                  :data-testid="`provider-key-rotate-button-${credential.id}`"
                  @click="onRotate(credential)"
                >
                  {{ t('fleet.providerKeys.actions.rotate') }}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  :disabled="savingId === credential.id"
                  :data-testid="`provider-key-toggle-${credential.id}`"
                  @click="onToggle(credential)"
                >
                  {{ credential.disabled ? t('fleet.providerKeys.actions.enable') : t('fleet.providerKeys.actions.disable') }}
                </Button>
              </div>
              <Button
                v-if="canDelete"
                size="sm"
                variant="destructive"
                :disabled="savingId === credential.id"
                :data-testid="`provider-key-delete-${credential.id}`"
                @click="onDelete(credential)"
              >
                {{ t('fleet.providerKeys.actions.delete') }}
              </Button>
              <p v-if="rotateErrors[credential.id]" role="alert" class="text-xs text-status-rejected" :data-testid="`provider-key-rotate-error-${credential.id}`">
                {{ rotateErrors[credential.id] }}
              </p>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="hasMore" class="text-sm text-muted-foreground">{{ t('fleet.common.more', { n: FLEET_LIST_SIZE }) }}</p>
    </template>
  </div>
</template>
