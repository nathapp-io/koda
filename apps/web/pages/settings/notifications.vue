<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useNotificationPreferences } from '~/composables/useNotificationPreferences'
import { NOTIFICATION_CATEGORIES } from '~/lib/notification-types'
import type { NotificationCategory } from '~/lib/notification-types'

definePageMeta({ layout: 'default' })

/** Notification preferences; missing category rows default to on for in-app and email. */
const { t } = useI18n()
const toast = useAppToast()
const { view, pending, load, setInApp, setEmail, setEmailEnabled } = useNotificationPreferences()

const rows = computed(() => NOTIFICATION_CATEGORIES.map((category) => {
  const item = view.value.items.find((i) => i.category === category)
  return { category, inApp: item?.inApp ?? true, email: item?.email ?? true }
}))

/** True when the first load failed: never show defaulted (all-on) toggles the user could save over real settings. */
const loadFailed = ref(false)

async function reload(): Promise<void> {
  try {
    await load()
    loadFailed.value = false
  } catch (err: unknown) {
    loadFailed.value = view.value.items.length === 0
    toast.error(extractApiError(err))
  }
}

async function onToggle(category: NotificationCategory, event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const checked = box.checked
  try {
    await setInApp(category, checked)
    toast.success(t('notifications.preferences.saved'))
  } catch (err: unknown) {
    box.checked = !checked
    toast.error(extractApiError(err))
  }
}

async function onEmailToggle(category: NotificationCategory, event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const checked = box.checked
  try {
    await setEmail(category, checked)
    toast.success(t('notifications.preferences.saved'))
  } catch (err: unknown) {
    box.checked = !checked
    toast.error(extractApiError(err))
  }
}

async function onEmailEnabledToggle(event: Event): Promise<void> {
  const box = event.target as HTMLInputElement
  const checked = box.checked
  try {
    await setEmailEnabled(checked)
    toast.success(t('notifications.preferences.saved'))
  } catch (err: unknown) {
    box.checked = !checked
    toast.error(extractApiError(err))
  }
}

onMounted(() => { void reload() })
</script>

<template>
  <div class="max-w-2xl space-y-6">
    <PageHeader :title="t('notifications.preferences.title')" :subtitle="t('notifications.preferences.subtitle')" />
    <LoadingState v-if="pending && view.items.length === 0" />
    <ErrorState v-else-if="loadFailed" @retry="reload()" />
    <div v-else class="space-y-4">
      <p v-if="!view.emailAvailable" class="text-sm text-muted-foreground">{{ t('notifications.preferences.emailUnavailable') }}</p>
      <label class="flex items-center justify-between gap-4 rounded-md border border-border px-4 py-3">
        <span class="text-sm font-medium">{{ t('notifications.preferences.emailEnabled') }}</span>
        <input
          id="notification-email-master"
          data-testid="notification-email-master"
          type="checkbox"
          class="h-4 w-4 accent-primary"
          :checked="view.emailEnabled"
          :disabled="!view.emailAvailable"
          @change="onEmailEnabledToggle($event)"
        >
      </label>
    <ul class="divide-y divide-border rounded-md border border-border">
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
        <span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {{ t('notifications.preferences.email') }}
          <input
            :id="`notification-pref-email-${row.category}`"
            :data-testid="`notification-pref-email-${row.category}`"
            type="checkbox"
            class="h-4 w-4 accent-primary"
            :checked="row.email"
            :disabled="!view.emailAvailable || !view.emailEnabled"
            @change="onEmailToggle(row.category, $event)"
          >
        </span>
      </li>
    </ul>
    </div>
  </div>
</template>
