<script setup lang="ts">
import { onMounted } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useAdminOutbox, type OutboxStatus } from '~/composables/useAdminOutbox'
import { FILTER_CONTROL_CLASS } from '~/lib/form-control'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { items, total, isLoading, error, status, load, retry } = useAdminOutbox()
const { permissions: globalPermissions } = useGlobalPermissions()
const adminOnly = ref(false)
let latestRequestId = 0

async function reload(): Promise<void> {
  const requestId = ++latestRequestId
  adminOnly.value = false
  try {
    await load()
  }
  catch (err: unknown) {
    if (requestId !== latestRequestId) return
    if (err instanceof ApiError && err.code === 403) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
}

function onStatusChange(value: string): void {
  status.value = value as OutboxStatus
  void reload()
}

function canRetry(item: { status: OutboxStatus }): boolean {
  return globalPermissions.value.has('outbox.retry') && (item.status === 'dead' || item.status === 'pending')
}

async function retryEvent(id: string): Promise<void> {
  try {
    const outcome = await retry(id)
    if (outcome.kind === 'pending') {
      toast.success(t('outbox.retry.pending'))
      return
    }
    toast.success(t('outbox.retry.done'))
    await reload()
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('outbox.title')" />

    <div class="flex flex-col gap-1">
      <label for="outbox-status" class="text-xs font-medium text-muted-foreground">{{ t('outbox.status.label') }}</label>
      <select
        id="outbox-status"
        :value="status"
        :class="[FILTER_CONTROL_CLASS, 'w-fit']"
        @change="onStatusChange(($event.target as HTMLSelectElement).value)"
      >
        <option value="dead">{{ t('outbox.status.dead') }}</option>
        <option value="pending">{{ t('outbox.status.pending') }}</option>
        <option value="processing">{{ t('outbox.status.processing') }}</option>
        <option value="published">{{ t('outbox.status.published') }}</option>
      </select>
    </div>

    <LoadingState v-if="isLoading" />
    <div v-else-if="adminOnly" class="rounded-lg border border-dashed border-border py-16 text-center">
      <p class="text-sm font-medium text-muted-foreground">{{ t('outbox.adminOnly') }}</p>
    </div>
    <div v-else-if="error" class="rounded-lg border border-dashed border-border py-16 text-center">
      <p class="text-sm font-medium text-muted-foreground">{{ t('outbox.error') }}</p>
    </div>
    <template v-else>
      <p class="text-sm text-muted-foreground">{{ t('outbox.showing', { count: items.length, total }) }}</p>
      <div v-if="items.length === 0" class="rounded-lg border border-dashed border-border py-16 text-center">
        <p class="text-sm font-medium text-muted-foreground">{{ t('outbox.empty') }}</p>
      </div>
      <div v-else class="overflow-x-auto rounded-lg border border-border">
        <table class="w-full text-sm">
          <thead><tr class="border-b border-border text-left">
            <th class="p-3">{{ t('outbox.columns.type') }}</th>
            <th class="p-3">{{ t('outbox.columns.eventId') }}</th>
            <th class="p-3">{{ t('outbox.columns.attempts') }}</th>
            <th class="p-3">{{ t('outbox.columns.lastError') }}</th>
            <th class="p-3" />
          </tr></thead>
          <tbody>
            <tr v-for="item in items" :key="item.id" class="border-b border-border last:border-0">
              <td class="p-3">{{ item.type }}</td>
              <td class="p-3">{{ item.eventId }}</td>
              <td class="p-3">{{ item.attempts }}</td>
              <td class="p-3">{{ item.lastError ?? '—' }}</td>
              <td class="p-3">
                <button v-if="canRetry(item)" type="button" class="text-sm text-link hover:underline" @click="retryEvent(item.id)">
                  {{ t('outbox.retry.action') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
