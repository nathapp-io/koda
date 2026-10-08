<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useNotificationPreferences } from '~/composables/useNotificationPreferences'
import { NOTIFICATION_CATEGORIES } from '~/lib/notification-types'
import type { NotificationCategory } from '~/lib/notification-types'

definePageMeta({ layout: 'default' })

/** Fleet S4a §5: per-category in-app toggles (a missing row means on; the API resolves defaults). */
const { t } = useI18n()
const toast = useAppToast()
const { items, pending, load, setInApp } = useNotificationPreferences()

const rows = computed(() => NOTIFICATION_CATEGORIES.map((category) => ({
  category,
  inApp: items.value.find((i) => i.category === category)?.inApp ?? true,
})))

async function reload(): Promise<void> {
  try {
    await load()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

async function onToggle(category: NotificationCategory, event: Event): Promise<void> {
  const checked = (event.target as HTMLInputElement).checked
  try {
    await setInApp(category, checked)
    toast.success(t('notifications.preferences.saved'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    await reload()
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <PageHeader :title="t('notifications.preferences.title')" :subtitle="t('notifications.preferences.subtitle')" />
    <LoadingState v-if="pending && items.length === 0" />
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="row in rows" :key="row.category" class="flex items-center justify-between gap-4 px-4 py-3">
        <label :for="`notification-pref-${row.category}`" class="min-w-0">
          <span class="block text-sm font-medium">{{ t(`notifications.categories.${row.category}.label`) }}</span>
          <span class="block text-xs text-muted-foreground">{{ t(`notifications.categories.${row.category}.description`) }}</span>
        </label>
        <span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {{ t('notifications.preferences.inApp') }}
          <input
            :id="`notification-pref-${row.category}`"
            type="checkbox"
            class="h-4 w-4 accent-primary"
            :checked="row.inApp"
            :data-testid="`notification-pref-${row.category}`"
            @change="onToggle(row.category, $event)"
          >
        </span>
      </li>
    </ul>
  </div>
</template>
