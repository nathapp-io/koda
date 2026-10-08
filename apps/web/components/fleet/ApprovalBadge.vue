<template>
  <div class="inline-flex items-center gap-2">
    <NuxtLink
      v-if="target"
      :to="target"
      class="inline-flex animate-pulse items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/15 px-2 py-1 text-sm font-semibold text-foreground hover:bg-amber-500/25"
      :aria-label="t('fleet.approvals.badge.label', { count })"
      :title="t('fleet.approvals.badge.label', { count })"
      aria-live="polite"
      data-testid="fleet-approval-badge"
      :data-count="count"
    >
      <Inbox class="h-4 w-4" />
      <span class="rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">{{ t('fleet.approvals.badge.waiting', { count: badgeText(count) }) }}</span>
    </NuxtLink>
    <button
      v-if="notifications.supported.value"
      type="button"
      class="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      :aria-label="t(notifications.enabled.value ? 'fleet.approvals.notifications.disable' : 'fleet.approvals.notifications.enable')"
      :title="t(notifications.enabled.value ? 'fleet.approvals.notifications.disable' : 'fleet.approvals.notifications.enable')"
      :aria-pressed="notifications.enabled.value"
      data-testid="fleet-approval-notifications"
      @click="notifications.toggleBrowserNotifications"
    >
      <Bell class="h-4 w-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { Bell, Inbox } from 'lucide-vue-next'
import { approvalsVersion, useFleetApprovalCounts } from '~/composables/useFleetApprovals'
import { useApprovalNotifications } from '~/composables/useApprovalNotifications'
import { browserPollingDeps } from '~/composables/useVisiblePolling'
import { createDebouncer } from '~/lib/debounce'
import { badgeTarget, badgeText } from '~/lib/fleet-approvals'

/** D247: 60 s backstop; live notices and decides refresh sooner. */
const POLL_MS = 60_000

// Keyed by slug in the layout, so a project change mounts a fresh badge with the right subscription.
const props = defineProps<{ slug: string | null }>()

const { t } = useI18n()
const auth = useAuth()
const { counts, load } = useFleetApprovalCounts()
const notifications = useApprovalNotifications(counts)

const count = computed(() => counts.value?.total ?? 0)
const target = computed(() => {
  if (counts.value === null || count.value === 0) return null
  return badgeTarget(counts.value, { slug: props.slug, globalAdmin: auth.user.value?.role === 'ADMIN' })
})

useHead(() => {
  const prefix = count.value > 0 ? `(${count.value}) ` : ''
  return { titleTemplate: (title: string | undefined) => `${prefix}${title || 'Koda'}` }
})

async function refresh(): Promise<void> {
  try {
    await load()
    await notifications.refresh()
  } catch {
    // Cosmetic: keep the last count and try again at the next poll or notice.
  }
}

// Notification delivery must continue in hidden tabs, including admin pages with no live stream.
const polling = useVisiblePolling(refresh, POLL_MS, { ...browserPollingDeps(), isHidden: () => false })
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
watch(approvalsVersion, () => liveReload.trigger())
if (props.slug) {
  useProjectEvents(props.slug, {
    onFleetApproval: (event) => {
      if (event && event.status !== 'pending') notifications.decided(event.approvalId)
      liveReload.trigger()
    },
    onResync: () => liveReload.trigger(),
  })
}
</script>
