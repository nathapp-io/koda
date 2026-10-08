<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="relative rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      :aria-label="t('notifications.bell.label', { count: unreadCount })"
      :title="t('notifications.bell.label', { count: unreadCount })"
      :aria-expanded="open ? 'true' : 'false'"
      aria-haspopup="dialog"
      data-testid="notification-bell"
      :data-count="unreadCount"
      @click="toggle"
    >
      <BellDot v-if="unreadCount > 0" class="h-5 w-5" />
      <Bell v-else class="h-5 w-5" />
      <span
        v-if="unreadCount > 0"
        aria-live="polite"
        class="absolute -right-1 -top-1 rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
        data-testid="notification-bell-count"
      >{{ badgeText(unreadCount) }}</span>
    </button>

    <div
      v-if="open"
      role="dialog"
      :aria-label="t('notifications.bell.title')"
      class="absolute right-0 z-40 mt-2 w-80 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
      data-testid="notification-panel"
      @keydown.esc="open = false"
    >
      <div class="flex items-center justify-between px-2 pb-2">
        <span class="text-sm font-semibold">{{ t('notifications.bell.title') }}</span>
        <button
          type="button"
          class="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="unreadCount === 0"
          data-testid="notification-mark-all"
          @click="onMarkAll"
        >
          {{ t('notifications.markAllRead') }}
        </button>
      </div>
      <p v-if="latest.length === 0" class="px-2 py-4 text-sm text-muted-foreground" data-testid="notification-empty">
        {{ t('notifications.empty') }}
      </p>
      <ul v-else class="max-h-96 space-y-1 overflow-y-auto">
        <li v-for="item in latest" :key="item.id">
          <button
            type="button"
            class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            :class="item.readAt ? 'text-muted-foreground' : 'font-medium text-foreground'"
            data-testid="notification-item"
            :data-id="item.id"
            @click="onOpen(item)"
          >
            <span class="block truncate">{{ notificationText(item, i18n) }}</span>
            <span v-if="item.body" class="block truncate text-xs text-muted-foreground">{{ item.body }}</span>
          </button>
        </li>
      </ul>
      <div class="mt-2 flex items-center justify-between border-t border-border px-2 pt-2 text-xs">
        <NuxtLink to="/notifications" class="text-primary hover:underline" data-testid="notification-view-all" @click="open = false">
          {{ t('notifications.viewAll') }}
        </NuxtLink>
        <NuxtLink to="/settings/notifications" class="text-muted-foreground hover:underline" @click="open = false">
          {{ t('notifications.settings') }}
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Bell, BellDot } from 'lucide-vue-next'
import { extractApiError } from '~/composables/useApi'
import { useNotifications } from '~/composables/useNotifications'
import { useUserEvents } from '~/composables/useUserEvents'
import { createDebouncer } from '~/lib/debounce'
import { badgeText } from '~/lib/fleet-approvals'
import { isInAppPath, notificationText } from '~/lib/notifications'
import type { NotificationDto } from '~/lib/notification-types'

/** Fleet S4a §5: header bell. Live notices and the 60 s poll refresh it; the API owns read state. */
const i18n = useI18n()
const { t } = i18n
const toast = useAppToast()
const { unreadCount, latest, refresh, markRead, markAllRead } = useNotifications()
const open = ref(false)
const root = ref<HTMLElement | null>(null)

async function reload(): Promise<void> {
  try {
    await refresh()
  } catch {
    // Cosmetic: keep the last count; the next notice or poll retries.
  }
}

const liveReload = createDebouncer(() => { void reload() }, 300)
useUserEvents(() => liveReload.trigger())

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false
}

onMounted(() => {
  void reload()
  if (typeof document !== 'undefined') document.addEventListener('click', onDocumentClick)
})
onBeforeUnmount(() => {
  liveReload.cancel()
  if (typeof document !== 'undefined') document.removeEventListener('click', onDocumentClick)
})

function toggle(): void {
  open.value = !open.value
  if (open.value) void reload()
}

async function onOpen(item: NotificationDto): Promise<void> {
  open.value = false
  if (!item.readAt) {
    try {
      await markRead(item.id)
    } catch {
      // Navigation still happens; the item stays unread until the next refresh.
    }
  }
  if (isInAppPath(item.link)) await navigateTo(item.link)
}

async function onMarkAll(): Promise<void> {
  try {
    await markAllRead()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}
</script>
