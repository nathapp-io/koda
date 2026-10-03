<template>
  <NuxtLink
    v-if="target"
    :to="target"
    class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium text-foreground hover:bg-accent"
    :aria-label="t('fleet.approvals.badge.label', { count })"
    :title="t('fleet.approvals.badge.label', { count })"
    data-testid="fleet-approval-badge"
    :data-count="count"
  >
    <Inbox class="h-4 w-4" />
    <span class="rounded-full bg-destructive px-1.5 text-xs text-destructive-foreground">{{ badgeText(count) }}</span>
  </NuxtLink>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { Inbox } from 'lucide-vue-next'
import { approvalsVersion, useFleetApprovalCounts } from '~/composables/useFleetApprovals'
import { createDebouncer } from '~/lib/debounce'
import { badgeTarget, badgeText } from '~/lib/fleet-approvals'

/** D247: 60 s backstop; live notices and decides refresh sooner. */
const POLL_MS = 60_000

// Keyed by slug in the layout, so a project change mounts a fresh badge with the right subscription.
const props = defineProps<{ slug: string | null }>()

const { t } = useI18n()
const auth = useAuth()
const { counts, load } = useFleetApprovalCounts()

const count = computed(() => counts.value?.total ?? 0)
const target = computed(() => {
  if (counts.value === null || count.value === 0) return null
  return badgeTarget(counts.value, { slug: props.slug, globalAdmin: auth.user.value?.role === 'ADMIN' })
})

async function refresh(): Promise<void> {
  try {
    await load()
  } catch {
    // Cosmetic: keep the last count and try again at the next poll or notice.
  }
}

const polling = useVisiblePolling(refresh, POLL_MS)
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
    onFleetApproval: () => liveReload.trigger(),
    onResync: () => liveReload.trigger(),
  })
}
</script>
