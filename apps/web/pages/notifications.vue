<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useNotifications } from '~/composables/useNotifications'
import { useUserEvents } from '~/composables/useUserEvents'
import { createDebouncer } from '~/lib/debounce'
import { isInAppPath, notificationText } from '~/lib/notifications'
import type { NotificationDto, NotificationPage } from '~/lib/notification-types'

definePageMeta({ layout: 'default' })

/** Fleet S4a §5: the full inbox, newest first, with an unread filter. */
const i18n = useI18n()
const { t } = i18n
const toast = useAppToast()
const { list, markRead, markAllRead, unreadCount } = useNotifications()

const unreadOnly = ref(false)
const data = ref<NotificationPage | null>(null)
const failed = ref(false)

async function load(current = 1): Promise<void> {
  try {
    data.value = await list({ current, unreadOnly: unreadOnly.value })
    failed.value = false
  } catch {
    failed.value = true
  }
}

async function setFilter(value: boolean): Promise<void> {
  unreadOnly.value = value
  await load(1)
}

async function open(item: NotificationDto): Promise<void> {
  if (!item.readAt) {
    try {
      await markRead(item.id)
    } catch {
      // Navigation still happens.
    }
  }
  if (isInAppPath(item.link)) await navigateTo(item.link)
}

async function readAll(): Promise<void> {
  try {
    await markAllRead()
    await load(data.value?.current ?? 1)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

const liveReload = createDebouncer(() => { void load(data.value?.current ?? 1) }, 300)
useUserEvents(() => liveReload.trigger())
onMounted(() => { void load(1) })
onBeforeUnmount(() => liveReload.cancel())
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('notifications.title')" :subtitle="t('notifications.subtitle')">
      <template #actions>
        <Button variant="outline" :disabled="unreadCount === 0" data-testid="notifications-mark-all" @click="readAll()">
          {{ t('notifications.markAllRead') }}
        </Button>
      </template>
    </PageHeader>

    <div class="flex gap-2">
      <Button
        size="sm"
        :variant="unreadOnly ? 'outline' : 'default'"
        :aria-pressed="unreadOnly ? 'false' : 'true'"
        data-testid="notifications-filter-all"
        @click="setFilter(false)"
      >
        {{ t('notifications.filter.all') }}
      </Button>
      <Button
        size="sm"
        :variant="unreadOnly ? 'default' : 'outline'"
        :aria-pressed="unreadOnly ? 'true' : 'false'"
        data-testid="notifications-filter-unread"
        @click="setFilter(true)"
      >
        {{ t('notifications.filter.unread') }}
      </Button>
    </div>

    <ErrorState v-if="failed && !data" @retry="load(1)" />
    <LoadingState v-else-if="!data" />
    <p v-else-if="data.records.length === 0" class="text-sm text-muted-foreground" data-testid="notifications-empty">
      {{ unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty') }}
    </p>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li v-for="item in data.records" :key="item.id">
        <button
          type="button"
          class="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-accent"
          :class="item.readAt ? 'text-muted-foreground' : 'text-foreground'"
          data-testid="notifications-row"
          :data-id="item.id"
          @click="open(item)"
        >
          <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="item.readAt ? 'bg-transparent' : 'bg-primary'" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm" :class="item.readAt ? '' : 'font-medium'">{{ notificationText(item, i18n) }}</span>
            <span v-if="item.body" class="block truncate text-xs text-muted-foreground">{{ item.body }}</span>
          </span>
          <time class="shrink-0 text-xs text-muted-foreground" :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleString() }}</time>
        </button>
      </li>
    </ul>

    <div v-if="data" class="flex gap-2">
      <Button variant="outline" size="sm" :disabled="data.current <= 1" data-testid="notifications-prev" @click="load(data.current - 1)">
        {{ t('notifications.prev') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="!data.hasNext" data-testid="notifications-next" @click="load(data.current + 1)">
        {{ t('notifications.next') }}
      </Button>
    </div>
  </div>
</template>
