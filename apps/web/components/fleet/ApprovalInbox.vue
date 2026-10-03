<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="inline-flex rounded-md border border-border p-0.5" role="tablist">
        <Button
          v-for="name in INBOX_TABS"
          :key="name"
          size="sm"
          :variant="tab === name ? 'default' : 'ghost'"
          role="tab"
          :aria-selected="tab === name"
          :data-testid="`fleet-approvals-tab-${name}`"
          @click="tab = name"
        >
          {{ t(`fleet.approvals.tabs.${name}`) }}
        </Button>
      </div>
      <div class="w-56">
        <FleetNativeSelect id="fleet-approvals-type" v-model="type" :options="typeOptions" testid="fleet-approvals-type" />
      </div>
    </div>

    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="reload()" />
    <template v-else-if="!forbidden">
      <EmptyState v-if="displayRows.length === 0" :message="t(`fleet.approvals.empty.${tab}`)" />
      <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-approvals-list">
        <li
          v-for="entry in displayRows"
          :key="entry.row.id"
          :data-testid="`fleet-approval-row-${entry.row.id}`"
          :data-status="entry.row.status"
          :data-type="entry.row.type"
          :data-linked="String(entry.linked)"
        >
          <p v-if="entry.linked" class="px-3 pt-2 text-xs font-medium text-muted-foreground">{{ t('fleet.approvals.linked') }}</p>
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
            :aria-expanded="expandedId === entry.row.id"
            data-testid="fleet-approval-toggle"
            @click="toggle(entry.row.id)"
          >
            <Badge variant="outline">{{ label('fleet.approvals.type', entry.row.type) }}</Badge>
            <span class="min-w-0 flex-1">{{ approvalSummary(t, entry.row, scopeLabel) }}</span>
            <span v-if="projectName" class="text-xs text-muted-foreground">{{ projectName(entry.row.projectId) }}</span>
            <Badge :variant="entry.row.status === 'pending' ? 'default' : 'secondary'" data-testid="fleet-approval-status">
              {{ label('fleet.approvals.status', entry.row.status) }}
            </Badge>
            <span
              v-if="entry.left !== null"
              class="font-mono text-xs"
              :class="entry.left === 0 ? 'text-destructive' : 'text-muted-foreground'"
              data-testid="fleet-approval-countdown"
            >{{ countdownText(entry.left) }}</span>
            <span class="text-xs text-muted-foreground"><FleetAge :iso="entry.row.requestedAt" :now="now" mode="ago" /></span>
          </button>
          <div v-if="expandedId === entry.row.id" class="border-t border-border px-3 py-3" data-testid="fleet-approval-panel">
            <LoadingState v-if="detail === null || detail.id !== entry.row.id" />
            <template v-else>
              <FleetApprovalBudgetPanel
                v-if="detail.type === 'budget_override_required' && detail.status === 'pending'"
                :key="`${detail.id}:${detail.status}:${detailVersion}`"
                :approval="detail"
                :can-decide="canDecide(detail, viewer)"
                :busy="deciding"
                :job-link="jobLink"
                @decide="onDecide"
              />
              <FleetApprovalBashPanel
                v-else-if="detail.type === 'nax_bash_escalate' && detail.status === 'pending'"
                :key="`${detail.id}:${detail.status}:${detailVersion}`"
                :approval="detail"
                :can-decide="canDecide(detail, viewer)"
                :busy="deciding"
                :now="now"
                :job-href="detail.projectId && detail.jobId ? jobLink(detail.projectId, detail.jobId) : null"
                @decide="onDecide"
              />
              <FleetApprovalOutcome v-else :approval="detail" :name-of="nameOf" :job-link="jobLink" />
            </template>
          </div>
        </li>
      </ul>

      <p v-if="tab === 'pending' && api.hasNext.value" class="text-sm text-muted-foreground" data-testid="fleet-approvals-more">
        {{ t('fleet.approvals.more', { n: INBOX_PENDING_SIZE }) }}
      </p>
      <div v-if="tab === 'all' && (page > 1 || api.hasNext.value)" class="flex justify-end gap-2">
        <Button variant="outline" size="sm" :disabled="page <= 1" data-testid="fleet-approvals-prev" @click="goTo(page - 1)">{{ t('fleet.jobs.previous') }}</Button>
        <Button variant="outline" size="sm" :disabled="!api.hasNext.value" data-testid="fleet-approvals-next" @click="goTo(page + 1)">{{ t('fleet.jobs.next') }}</Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetApprovals } from '~/composables/useFleetApprovals'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { createDebouncer } from '~/lib/debounce'
import {
  approvalSummary, canDecide, countdownText, deliveryView, INBOX_PENDING_SIZE, INBOX_TABS, requeueResults, secondsLeft,
} from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalViewer, BudgetApprovalPayload, InboxTab } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import { APPROVAL_TYPES } from '~/lib/fleet-types'
import type { ApprovalType, DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

const props = defineProps<{
  base: ApprovalBase
  viewer: ApprovalViewer
  scopeLabel: (p: BudgetApprovalPayload) => string | null
  nameOf: (userId: string) => string | null
  jobLink: (projectId: string, jobId: string) => string | null
  projectName?: (projectId: string | null) => string
}>()

const emit = defineEmits<{ (e: 'forbidden'): void }>()

/** D252: the project inbox also listens live; the admin inbox has no live channel. */
const POLL_MS = props.base.kind === 'admin' ? 15_000 : 30_000
/** Native selects cannot carry undefined; '' is "all types". */
const ALL = ''

const { t, te } = useI18n()
const toast = useAppToast()
const route = useRoute()
const router = useRouter()
const api = useFleetApprovals(props.base)

const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)
const typeOptions = computed(() => [
  { value: ALL, label: t('fleet.approvals.filters.allTypes') },
  ...APPROVAL_TYPES.map((value) => ({ value, label: t(`fleet.approvals.type.${value}`) })),
])

const tab = ref<InboxTab>('pending')
const type = ref<string>(ALL)
const page = ref(1)
/** D292: one clock for row ages and countdowns. */
const { now } = useApprovalCountdown()
const pending = ref(true)
const loaded = ref(false)
const loadFailed = ref(false)
const stale = ref(false)
const forbidden = ref(false)
const deciding = ref(false)

const initialId = typeof route.query.id === 'string' && route.query.id !== '' ? route.query.id : null
const expandedId = ref<string | null>(initialId)
/** GET :id of the expanded approval (candidates exist only there). */
const detail = ref<FleetApprovalDto | null>(null)
/** Bumped on every fetch of the open approval: part of the panel key, so fresh candidates remount the form (D250). */
const detailVersion = ref(0)

/** D241: the expanded approval first when it is not on the loaded page. `left` drives the row countdown (D296). */
const displayRows = computed(() => {
  const withLeft = (row: FleetApprovalDto, linked: boolean) =>
    ({ row, linked, left: row.status === 'pending' ? secondsLeft(row.expiresAt, now.value) : null })
  const rows = api.approvals.value.map((row) => withLeft(row, false))
  const open = detail.value
  if (open === null || api.approvals.value.some((r) => r.id === open.id)) return rows
  return [withLeft(open, true), ...rows]
})

const isConflict = (err: unknown): boolean => err instanceof ApiError && (err.code === 40009 || err.code === 409)

function writeQuery(id: string | null): void {
  const rest = Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'id'))
  void router.replace({ query: id === null ? rest : { ...rest, id } })
}

async function loadDetail(id: string): Promise<void> {
  try {
    const fetched = await api.get(id)
    if (expandedId.value !== id) return
    detail.value = fetched
    detailVersion.value += 1
  } catch (err: unknown) {
    if (expandedId.value !== id) return
    toast.error(extractApiError(err))
    expandedId.value = null
    detail.value = null
    writeQuery(null)
  }
}

/**
 * D242: the open approval is re-fetched only when its status changed: its listed status differs, or it was pending and
 * has left a complete Pending list (decided elsewhere, so it is no longer returned for `status=pending`).
 */
function statusChanged(): boolean {
  const open = detail.value
  if (open === null) return false
  const listed = api.approvals.value.find((r) => r.id === open.id)
  if (listed !== undefined) return listed.status !== open.status
  return open.status === 'pending' && tab.value === 'pending' && !api.hasNext.value
}

/** D295: acks have no live event, so a decided ask still waiting for one is re-fetched on reload, for 10 minutes at most. */
const DELIVERY_WATCH_MS = 600_000
const awaitingDelivery = (): boolean => {
  const open = detail.value
  if (open === null || deliveryView(open)?.state !== 'waiting') return false
  const decidedAt = Date.parse(open.decidedAt ?? '')
  return Number.isNaN(decidedAt) || Date.now() - decidedAt < DELIVERY_WATCH_MS
}

async function reload(): Promise<void> {
  try {
    const accepted = await api.load({ tab: tab.value, type: (type.value || undefined) as ApprovalType | undefined, page: page.value })
    if (!accepted) return
    loaded.value = true
    loadFailed.value = false
    stale.value = false
    if ((statusChanged() || awaitingDelivery()) && expandedId.value !== null) await loadDetail(expandedId.value)
  } catch (err: unknown) {
    if (isForbidden(err)) {
      forbidden.value = true
      emit('forbidden')
      polling.stop()
    } else if (loaded.value) {
      stale.value = true
    } else {
      loadFailed.value = true
      toast.error(extractApiError(err))
    }
  } finally {
    pending.value = false
  }
}

async function toggle(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null
    detail.value = null
    writeQuery(null)
    return
  }
  expandedId.value = id
  detail.value = null
  writeQuery(id)
  await loadDetail(id)
}

async function onDecide(body: DecideApprovalBody): Promise<void> {
  const id = expandedId.value
  if (id === null) return
  deciding.value = true
  try {
    const decided = await api.decide(id, body)
    if (expandedId.value === id) detail.value = decided
    toast.success(t(`fleet.approvals.toast.${body.decision}`))
    const failed = (requeueResults(decided) ?? []).filter((r) => !r.ok).length
    if (failed > 0) toast.error(t('fleet.approvals.toast.requeueFailed', { count: failed }))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
    // D250: any refusal re-fetches the approval (spend or candidates may have changed, e.g. a 400 "not a candidate");
    // a 409 also reloads the list, since someone else decided first.
    await loadDetail(id)
    if (isConflict(err)) await reload()
  } finally {
    deciding.value = false
  }
}

function goTo(next: number): void {
  page.value = next
  void reload()
}

watch([tab, type], () => {
  page.value = 1
  void reload()
})

// Declared after reload, which it runs; reload only reaches `polling` when it is called.
const polling = useVisiblePolling(reload, POLL_MS)
const liveReload = createDebouncer(() => { void reload() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
  if (initialId !== null) void loadDetail(initialId)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
if (props.base.kind === 'project') {
  useProjectEvents(props.base.slug, {
    onFleetApproval: () => liveReload.trigger(),
    onResync: () => liveReload.trigger(),
  })
}
</script>
