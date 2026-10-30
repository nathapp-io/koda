<template>
  <div v-if="!forbidden" class="inline-flex items-center gap-2">
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
/**
 * P3b US-006: the header badge on the approval engine.
 *
 * It counts what the inbox lists: `GET /approvals/counts` answers every visible pending request — the
 * caller's own included, which is deliberate, so the badge, the Pending tab and the home card agree on
 * one number. It is also the one approval surface every page has (a project stream is optional, and the
 * global inbox has none), so it polls and follows the tab's live events:
 *
 * - **Every successful counts load refreshes the notices** (`useApprovalRequestNotifications` takes the
 *   snapshot, so a `total: 0` answer reads no list at all).
 * - **The target is the inbox the caller can act in**: on a project page, that project's; off one, the
 *   global inbox when the global key set `mayDecide()`, else the first project the counts named; and no
 *   link when nothing is pending.
 * - **A refusal is not a transient failure.** A caller with no decide key anywhere gets a 403, so the
 *   badge stops polling and renders nothing. Any other error keeps the count and the notices on screen
 *   and retries at the next poll or event.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Bell, Inbox } from 'lucide-vue-next'
import { useApprovalInbox } from '~/composables/useApprovalInbox'
import { useApprovalRequestNotifications } from '~/composables/useApprovalRequestNotifications'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { browserPollingDeps } from '~/composables/useVisiblePolling'
import { createDebouncer } from '~/lib/debounce'
import { inboxHref } from '~/lib/approval-requests'
import { badgeText } from '~/lib/fleet-approvals'

/** D247: 60 s backstop; live events and decides refresh sooner. */
const POLL_MS = 60_000
/** A burst of `approval_request` events, or a decide followed by its own event, is one reload. */
const DEBOUNCE_MS = 300

// Keyed by slug in the layout, so a project change mounts a fresh badge with the right subscription.
const props = defineProps<{ slug: string | null }>()

const { t } = useI18n()
const inbox = useApprovalInbox()
const counts = inbox.requestCounts
const notifications = useApprovalRequestNotifications(counts)
// P3b US-006: off a project page, the caller's own decide keys pick the inbox — never a role name.
const { permissions: globalPermissions } = useGlobalPermissions()
/** A counts read the engine refused: nothing to poll for, and nothing to offer. */
const forbidden = ref(false)

const count = computed(() => counts.value?.total ?? 0)
const target = computed<string | null>(() => {
  const snapshot = counts.value
  if (snapshot === null || snapshot.total <= 0) return null
  if (props.slug !== null) return inboxHref(props.slug)
  if (globalPermissions.value.mayDecide()) return inboxHref(null)
  const first = snapshot.projects[0]
  return first === undefined ? null : inboxHref(first.slug)
})

useHead(() => {
  const prefix = count.value > 0 ? `(${count.value}) ` : ''
  return { titleTemplate: (title: string | undefined) => `${prefix}${title || 'Koda'}` }
})

/**
 * One poll: the counts, then the notices that read them. A refused read stops the poller; any other
 * failure keeps the last count and the notices and leaves the retry to the next poll or event.
 */
async function refresh(): Promise<void> {
  try {
    await inbox.counts()
  } catch (error: unknown) {
    if (isForbidden(error)) {
      forbidden.value = true
      polling.stop()
    }
    return
  }
  await notifications.refresh()
}

// Notification delivery must continue in hidden tabs, including admin pages with no live stream.
const polling = useVisiblePolling(refresh, POLL_MS, { ...browserPollingDeps(), isHidden: () => false })
const liveReload = createDebouncer(() => { void refresh() }, DEBOUNCE_MS)

onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
// A decide or cancel anywhere in this tab (the inbox, the job page, a notice) counts differently now.
watch(inbox.approvalRequestsVersion, () => liveReload.trigger())
if (props.slug !== null) {
  // The engine publishes only a project request's transitions; a project-less one arrives on no stream.
  useProjectEvents(props.slug, {
    onApprovalRequest: (event) => {
      // A settled request takes its notice with it at once: the notices read the *pending* list, so a
      // counts snapshot that fell to 0 reconciles nothing and the toast would stay on screen.
      if (event.status !== 'pending') notifications.decided(event.requestId)
      liveReload.trigger()
    },
    onResync: () => liveReload.trigger(),
  })
}
</script>
