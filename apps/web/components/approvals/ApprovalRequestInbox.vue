<template>
  <div class="space-y-4">
    <div class="inline-flex rounded-md border border-border p-0.5" role="tablist">
      <Button
        v-for="name in TABS"
        :key="name"
        size="sm"
        :variant="tab === name ? 'default' : 'ghost'"
        role="tab"
        :aria-selected="tab === name"
        :data-testid="`approvals-inbox-tab-${name}`"
        @click="selectTab(name)"
      >
        {{ t(`approvals.inbox.tabs.${name}`) }}
      </Button>
    </div>

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="approvals-inbox-forbidden">
      {{ t('approvals.inbox.forbidden') }}
    </p>
    <LoadingState v-else-if="pending" />
    <div v-else-if="loadFailed" class="space-y-3">
      <p class="text-sm text-status-rejected" data-testid="approvals-inbox-load-failed">{{ t('approvals.inbox.loadFailed') }}</p>
      <Button variant="outline" size="sm" data-testid="approvals-inbox-retry" @click="reload()">{{ t('common.retry') }}</Button>
    </div>
    <template v-else>
      <p v-if="stale" class="text-sm text-muted-foreground" data-testid="approvals-inbox-stale">{{ t('approvals.inbox.stale') }}</p>
      <EmptyState v-if="rows.length === 0" :message="t(`approvals.inbox.empty.${tab}`)" />
      <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="approvals-inbox-list">
        <li
          v-for="row in rows"
          :key="row.id"
          :data-testid="`approval-request-row-${row.id}`"
          :data-status="row.status"
          :data-linked="String(isLinked(row))"
        >
          <p v-if="isLinked(row)" class="px-3 pt-2 text-xs font-medium text-muted-foreground">
            {{ t('approvals.inbox.linked') }}
          </p>
          <button
            type="button"
            class="flex w-full flex-wrap items-center gap-3 px-3 py-2 text-left text-sm hover:bg-accent"
            :aria-expanded="openId === row.id"
            data-testid="approval-request-toggle"
            @click="toggle(row.id)"
          >
            <span class="min-w-0 flex-1 font-medium">{{ keyLabel(row.permissionKey) }}</span>
            <span class="text-xs text-muted-foreground" :title="t('approvals.inbox.row.requester')" data-testid="approval-request-requester">
              {{ requesterLabel(row) }}
            </span>
            <span class="text-xs text-muted-foreground" :title="t('approvals.inbox.row.project')" data-testid="approval-request-project">
              {{ projectLabel(row.projectId) }}
            </span>
            <Badge v-if="tab === 'all'" variant="secondary" data-testid="approval-request-status">
              {{ t(`approvals.inbox.status.${row.status}`) }}
            </Badge>
            <span
              v-if="secondsFor(row) !== null"
              class="font-mono text-xs"
              :class="secondsFor(row) === 0 ? 'text-status-rejected' : 'text-muted-foreground'"
              :title="t('approvals.inbox.row.expiresIn')"
              data-testid="approval-request-countdown"
            >{{ countdownText(secondsFor(row) ?? 0) }}</span>
          </button>
          <!-- US-003 renders the decide panel here for the open row; the detail it needs is already fetched. -->
          <div v-if="openId === row.id" class="border-t border-border px-3 py-3" data-testid="approval-request-detail">
            <LoadingState v-if="detailLoading" />
            <ApprovalRequestPanel
              v-else-if="detail?.id === row.id"
              :request="detail"
              :user-id="userId"
              :busy="mutationBusy"
              :project-slug="projectSlug"
              @decide="decide(row.id, $event)"
              @cancel="cancel(row.id)"
            />
          </div>
        </li>
      </ul>

      <div v-if="tab === 'all' && (page > 1 || hasNext)" class="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          data-testid="approvals-inbox-prev"
          @click="goTo(page - 1)"
        >{{ t('approvals.inbox.pager.prev') }}</Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="!hasNext"
          data-testid="approvals-inbox-next"
          @click="goTo(page + 1)"
        >{{ t('approvals.inbox.pager.next') }}</Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-002: the approval engine's inbox.
 *
 * Every row comes from the list answer alone — `ApprovalRequestSummaryDto` carries no `input`, `jobId`
 * or `details` — so a row shows its key label, its requester, its project and its countdown, and the
 * detail is fetched only for the row that opens. US-003 renders the panel in that detail region; US-004
 * adds the fleet-specific panels and the settled outcome there.
 *
 * The lookups a row's requester and project need belong to the page (member names on a project, admin
 * users and the project list globally), so the pages pass them in and a failed lookup only costs a name.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import { useApprovalInbox } from '~/composables/useApprovalInbox'
import type { DecideRequestBody } from '~/lib/approval-requests'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { REQUEST_TABS, requestKeyLabel, sortPendingRequests } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, ApprovalRequestSummary, RequestTab } from '~/lib/approval-requests'
import { createDebouncer } from '~/lib/debounce'
import { countdownText, secondsLeft } from '~/lib/fleet-approvals'

const props = defineProps<{
  base: { kind: 'all' } | { kind: 'project'; slug: string; projectId: string }
  /** A user requester's name; null (or a missing lookup) falls back to the id. */
  nameOf?: (userId: string) => string | null
  /** A row's project label in the global inbox; the project inbox knows its own slug. */
  projectName?: (projectId: string) => string
}>()

/** The global inbox has no live channel (the engine publishes no event for a project-less request). */
const POLL_MS = props.base.kind === 'all' ? 15_000 : 30_000
const TABS = REQUEST_TABS
/** A burst of `approval_request` events on the project stream is one reload. */
const DEBOUNCE_MS = 300

const { t, te } = useI18n()
const toast = useAppToast()
const route = useRoute()
const router = useRouter()
const { requests, page, hasNext, list, get, decide: postDecision, cancel: postCancel } = useApprovalInbox()
const { user } = useAuth()
const userId = computed(() => user.value?.id ?? null)
const mutationBusy = ref(false)
const { now } = useApprovalCountdown()

const tab = ref<RequestTab>('pending')
const pending = ref(true)
const loaded = ref(false)
const loadFailed = ref(false)
const stale = ref(false)
const forbidden = ref(false)
/** The open row, from the route on first paint (a notification links `/approvals?id=…`). */
const openId = ref<string | null>(typeof route.query.id === 'string' && route.query.id !== '' ? route.query.id : null)
/** GET /approvals/:id of the open row: what US-003's panel renders. */
const detail = ref<ApprovalRequestDetail | null>(null)
const detailLoading = ref(false)

const projectId = props.base.kind === 'project' ? props.base.projectId : undefined
/** Only the project inbox knows the slug a bash ask needs to link its job (US-004). */
const projectSlug = props.base.kind === 'project' ? props.base.slug : null

/**
 * The open row when the loaded page does not hold it — a link into `/approvals?id=…` may name a request
 * the default Pending page (one page of 100) does not list, and its detail must still be shown.
 */
const linkedRow = computed<ApprovalRequestSummary | null>(() => {
  const open = detail.value
  if (open === null || openId.value !== open.id) return null
  return requests.value.some((row) => row.id === open.id) ? null : open
})

/**
 * The rows on screen: the pending page in expiry order (those decisions run out first), with a linked
 * open request pinned above them when the page does not carry it.
 */
const rows = computed<ApprovalRequestSummary[]>(() => {
  const listed = tab.value === 'pending' ? sortPendingRequests(requests.value) : requests.value
  return linkedRow.value === null ? listed : [linkedRow.value, ...listed]
})

const isLinked = (row: ApprovalRequestSummary): boolean => linkedRow.value?.id === row.id

const keyLabel = (key: string): string => requestKeyLabel(t, te, key)

const requesterLabel = (row: ApprovalRequestSummary): string =>
  row.actorType === 'USER' ? (props.nameOf?.(row.actorId) ?? row.actorId) : row.actorId

/** A project-less request is the only one with no project to name. */
const projectLabel = (id: string | null): string => {
  if (id === null) return t('approvals.inbox.noProject')
  return props.base.kind === 'project' ? props.base.slug : (props.projectName?.(id) ?? id)
}

/** The countdown of a pending row; a settled row has none to run. */
const secondsFor = (row: ApprovalRequestSummary): number | null =>
  row.status === 'pending' ? secondsLeft(row.expiresAt, now.value) : null

/** `id` is the inbox's one query entry: everything else on the URL belongs to whoever linked here. */
function writeQuery(id: string | null): void {
  const rest = Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'id'))
  void router.replace({ query: id === null ? rest : { ...rest, id } })
}

async function loadDetail(id: string): Promise<void> {
  detailLoading.value = true
  try {
    const fetched = await get(id)
    if (openId.value === id) detail.value = fetched
  } catch (err: unknown) {
    if (openId.value !== id) return
    toast.error(extractApiError(err))
    openId.value = null
    detail.value = null
    writeQuery(null)
  } finally {
    detailLoading.value = false
  }
}

function isConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const value = error as { code?: unknown; statusCode?: unknown; status?: unknown }
  return value.code === 409 || value.statusCode === 409 || value.status === 409
}

async function recoverMutation(id: string, error: unknown): Promise<void> {
  toast.error(extractApiError(error))
  await loadDetail(id)
  if (isConflict(error)) await reload()
}

async function decide(id: string, body: DecideRequestBody): Promise<void> {
  if (mutationBusy.value) return
  mutationBusy.value = true
  try {
    const updated = await postDecision(id, body)
    if (openId.value === id) detail.value = updated
  } catch (error: unknown) {
    await recoverMutation(id, error)
  } finally {
    mutationBusy.value = false
  }
}

async function cancel(id: string): Promise<void> {
  if (mutationBusy.value) return
  mutationBusy.value = true
  try {
    const updated = await postCancel(id)
    if (openId.value === id) detail.value = updated
  } catch (error: unknown) {
    await recoverMutation(id, error)
  } finally {
    mutationBusy.value = false
  }
}

async function reload(): Promise<void> {
  try {
    await list(tab.value === 'pending' ? { tab: 'pending', projectId } : { tab: 'all', page: page.value, projectId })
    loaded.value = true
    loadFailed.value = false
    stale.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      // A refusal is not a transient failure: nothing to poll for.
      forbidden.value = true
      polling.stop()
    } else if (loaded.value) {
      // The rows already on screen stay: a failed refresh is a stale list, not an empty one.
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
  if (openId.value === id) {
    openId.value = null
    detail.value = null
    writeQuery(null)
    return
  }
  openId.value = id
  detail.value = null
  writeQuery(id)
  await loadDetail(id)
}

function selectTab(name: RequestTab): void {
  tab.value = name
}

function goTo(next: number): void {
  page.value = next
  void reload()
}

// A new tab is a new list: page 1 of it.
watch(tab, () => {
  page.value = 1
  void reload()
})

// Declared after reload, which it runs; reload only reaches `polling` when it is called.
const polling = useVisiblePolling(reload, POLL_MS)
const liveReload = createDebouncer(() => { void reload() }, DEBOUNCE_MS)

onMounted(() => {
  void polling.runNow()
  polling.start()
  if (openId.value !== null) void loadDetail(openId.value)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
if (props.base.kind === 'project') {
  // The engine publishes a request's transitions to its project's stream; a burst of them is one reload.
  useProjectEvents(props.base.slug, {
    onApprovalRequest: () => liveReload.trigger(),
    onResync: () => liveReload.trigger(),
  })
}
</script>
