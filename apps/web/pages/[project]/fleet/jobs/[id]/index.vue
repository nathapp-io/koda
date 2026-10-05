<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { budgetStopPolicyId } from '~/lib/fleet-budgets'
import { loadFleetJobDetail } from '~/lib/fleet-job-detail'
import { canCancelJob, canRequeueJob, canWorkOnFleet, isTerminalJobState, mayHaveBundle, mergeEvents, safePrUrl, wipPushStatus } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetApprovalDto, FleetJobDto, FleetJobEventDto } from '~/lib/fleet-types'
import FleetJobProgress from '~/components/fleet/FleetJobProgress.vue'
import FleetJobStories from '~/components/fleet/FleetJobStories.vue'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import FleetJobTimeline from '~/components/fleet/FleetJobTimeline.vue'
import FleetPlacementResult from '~/components/fleet/FleetPlacementResult.vue'
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import { useFleetApprovals } from '~/composables/useFleetApprovals'
import { firstPending, inboxPath } from '~/lib/fleet-approvals'
import { bashSummary } from '~/lib/fleet-bash-mode'
import FleetJobApprovals from '~/components/fleet/JobApprovals.vue'
import FleetJobAnalytics from '~/components/fleet/JobAnalytics.vue'
import { bundleExpiredByLogs, logAttemptEpochs } from '~/lib/fleet-job-logs-link'
import type { FleetJobLogListDto } from '~/lib/fleet-log-types'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const jobId = route.params.id as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const { data: viewerRole } = useProjectViewerRole(slug)

const logsApi = useFleetJobLogs(slug, jobId)
/** S2a §4.2: the log list drives the timeline's "Full log" rows and the expired-bundle button. */
const logList = ref<FleetJobLogListDto | null>(null)
/** D357: a bundle download answered 410. */
const bundleGone = ref(false)

const approvalsApi = useFleetApprovals({ kind: 'project', slug })
const { now } = useApprovalCountdown()
/** D297: this job's approvals (bash asks), newest first. */
const jobApprovals = ref<FleetApprovalDto[]>([])

const job = ref<FleetJobDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const busy = ref(false)
const confirmCancel = ref(false)
const requeueResult = ref<DispatchResultDto | null>(null)

const events = ref<FleetJobEventDto[]>([])
const eventPage = ref(0)
const moreEvents = ref(false)
const loadingEvents = ref(false)

const viewer = computed(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
}))
const canCancel = computed(() => job.value !== null && canCancelJob(job.value, viewer.value))
const canRequeue = computed(() => job.value !== null && canRequeueJob(job.value, viewer.value))
const showBundle = computed(() => job.value !== null && mayHaveBundle(job.value.state))
const bundleExpired = computed(() => bundleGone.value || bundleExpiredByLogs(logList.value))
const logAttempts = computed(() => logAttemptEpochs(logList.value))
const logsHref = `/${slug}/fleet/jobs/${jobId}/logs`
const prUrl = computed(() => safePrUrl(job.value?.resultPrUrl))
const wipPush = computed(() => wipPushStatus(job.value?.wipPush))
const budgetPolicyId = computed(() => budgetStopPolicyId(job.value?.stateReason))
const cancelPending = computed(() => job.value !== null && job.value.cancelRequestedAt !== null && !isTerminalJobState(job.value.state))
const showApprovals = computed(() => job.value !== null && (job.value.bashMode !== 'raw' || jobApprovals.value.length > 0))
/** D297: Review opens the ask nax denies first; the inbox itself before the list has loaded. */
const reviewHref = computed(() => inboxPath({ kind: 'project', slug }, firstPending(jobApprovals.value)?.id))

async function loadApprovals(): Promise<void> {
  jobApprovals.value = await approvalsApi.listForJob(jobId)
}

async function loadLogList(): Promise<void> {
  logList.value = await logsApi.list()
}

/** Events only append (ordered by seq), so refetching from the last loaded page is enough. */
async function loadEventsFrom(pageNo: number): Promise<void> {
  loadingEvents.value = true
  try {
    const res = await jobsApi.events(jobId, pageNo)
    events.value = mergeEvents(events.value, res.records ?? [])
    eventPage.value = pageNo
    moreEvents.value = res.hasNext === true
  }
  finally {
    loadingEvents.value = false
  }
}

async function loadJob(): Promise<boolean> {
  try {
    job.value = await jobsApi.get(jobId)
    loadFailed.value = false
    return true
  }
  catch (err: unknown) {
    loadFailed.value = true
    toast.error(extractApiError(err))
    return false
  }
  finally {
    pending.value = false
  }
}

function initializeRelatedData(): void {
  // An empty timeline must not read as "No events yet" when the load failed.
  void loadEventsFrom(1).catch((err: unknown) => toast.error(extractApiError(err)))
  // Approvals are secondary: a failure leaves the page usable.
  void loadApprovals().catch((err: unknown) => toast.error(extractApiError(err)))
  // Logs are secondary too: without the list the timeline has no "Full log" rows, the header link still works.
  void loadLogList().catch(() => undefined)
  // Names are cosmetic: a failure leaves ids (or "Unknown member") on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
}

async function loadJobDetail(): Promise<void> {
  await loadFleetJobDetail(loadJob, initializeRelatedData)
}

onMounted(loadJobDetail)

/** A busy job's runner logs can push new rows past the loaded page: follow hasNext, bounded (D139). */
const LIVE_CATCH_UP_PAGES = 10
async function catchUpEvents(): Promise<void> {
  await loadEventsFrom(Math.max(eventPage.value, 1))
  for (let i = 0; i < LIVE_CATCH_UP_PAGES && moreEvents.value; i += 1) {
    await loadEventsFrom(eventPage.value + 1)
  }
}

/** D396: bumped on every live reload; the Cost & quality section refetches on it (ingest completion publishes one). */
const analyticsReload = ref(0)

/** Live: never flip `pending` (it would swap the page for LoadingState); a failure waits for the next event. */
async function reloadSilently(): Promise<void> {
  analyticsReload.value += 1
  try {
    job.value = await jobsApi.get(jobId)
    await catchUpEvents()
    await loadApprovals()
    await loadLogList()
  }
  catch {
    // The next live event or a resync retries.
  }
}

const liveReload = createDebouncer(() => { void reloadSilently() }, 300)
onBeforeUnmount(() => liveReload.cancel())
useProjectEvents(slug, {
  onFleetJob: (event) => {
    if (event.jobId === jobId) liveReload.trigger()
  },
  onFleetApproval: () => liveReload.trigger(),
  // A new attempt's first bytes add its "Full log" row; growth of a known stream changes nothing here.
  onFleetLog: (event) => {
    if (event.jobId === jobId && !logAttempts.value.includes(event.leaseEpoch)) liveReload.trigger()
  },
  onResync: () => liveReload.trigger(),
})

async function act(run: () => Promise<void>): Promise<void> {
  busy.value = true
  try {
    await run()
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    busy.value = false
  }
}

const cancelJob = (): Promise<void> => act(async () => {
  job.value = await jobsApi.cancel(jobId)
  confirmCancel.value = false
  toast.success(t('fleet.jobs.toast.cancelRequested'))
})

const requeueJob = (): Promise<void> => act(async () => {
  const result = await jobsApi.requeue(jobId)
  job.value = result.job
  requeueResult.value = result
  toast.success(t('fleet.jobs.toast.requeued'))
  await catchUpEvents()
})

/** D357: a 410 turns the button into "Bundle expired" for the rest of the visit. */
const downloadBundle = (): Promise<void> => act(async () => {
  try {
    await jobsApi.downloadBundle(jobId)
  }
  catch (err: unknown) {
    if (err instanceof ApiError && err.code === 410) bundleGone.value = true
    throw err
  }
})

const formatTime = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '-')
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !job" @retry="loadJobDetail()" />
    <template v-else>
      <PageHeader :title="job.feature" :subtitle="`${job.command} | ${options.repoName(job.repoId)} @ ${job.ref}`">
        <template #actions>
          <NuxtLink :to="logsHref" class="inline-flex h-10 items-center rounded-md border border-input px-4 text-sm hover:bg-muted" data-testid="fleet-job-logs-link">
            {{ t('fleet.jobs.actions.logs') }}
          </NuxtLink>
          <Button v-if="showBundle" variant="outline" :disabled="busy || bundleExpired" data-testid="fleet-job-bundle" @click="downloadBundle()">
            {{ bundleExpired ? t('fleet.jobs.actions.bundleExpired') : t('fleet.jobs.actions.bundle') }}
          </Button>
          <Button v-if="canRequeue" variant="outline" :disabled="busy" data-testid="fleet-job-requeue" @click="requeueJob()">
            {{ t('fleet.jobs.actions.requeue') }}
          </Button>
          <Button v-if="canCancel" variant="destructive" :disabled="busy" data-testid="fleet-job-cancel" @click="confirmCancel = true">
            {{ t('fleet.jobs.actions.cancel') }}
          </Button>
        </template>
      </PageHeader>

      <FleetBudgetBanner :slug="slug" :repo-name="options.repoName" />

      <div class="flex flex-wrap items-center gap-3">
        <FleetJobStateBadge :state="job.state" />
        <span v-if="job.stateReason" class="text-sm text-muted-foreground" :title="job.stateReason" data-testid="fleet-job-state-reason">
          <template v-if="budgetPolicyId">
            {{ t('fleet.jobs.detail.budgetStop') }}
            <NuxtLink :to="`/${slug}/fleet/budgets`" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-budget-link">{{ t('fleet.jobs.detail.budgetStopLink') }}</NuxtLink>
          </template>
          <template v-else>{{ job.stateReason }}</template>
        </span>
        <span v-if="cancelPending" class="text-sm text-muted-foreground" data-testid="fleet-job-cancel-pending">
          {{ t('fleet.jobs.detail.cancelRequested', { at: formatTime(job.cancelRequestedAt) }) }}
        </span>
        <span v-if="job.scheduleId" class="text-sm text-muted-foreground" data-testid="fleet-job-schedule">
          {{ t('fleet.jobs.detail.fromSchedule') }}
          <NuxtLink :to="`/${slug}/fleet/schedules/${job.scheduleId}`" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-schedule-link">{{ t('fleet.jobs.detail.openSchedule') }}</NuxtLink>
        </span>
        <span v-if="job.coalescedCount > 0" class="text-sm text-muted-foreground" data-testid="fleet-job-coalesced">
          {{ t('fleet.jobs.detail.coalesced', { count: job.coalescedCount }) }}
        </span>
      </div>

      <div v-if="job.pendingApprovals > 0" class="flex flex-wrap items-center gap-3 rounded-md border border-primary p-4 text-sm" data-testid="fleet-job-approval-callout">
        <span class="font-medium">{{ t('fleet.jobs.detail.waitingApproval', { count: job.pendingApprovals }) }}</span>
        <NuxtLink :to="reviewHref" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-approval-review">{{ t('fleet.jobs.detail.reviewApproval') }}</NuxtLink>
      </div>

      <section v-if="requeueResult" class="space-y-2" data-testid="fleet-job-requeue-result">
        <h2 class="text-sm font-medium">{{ t('fleet.jobs.requeuePlacement') }}</h2>
        <FleetPlacementResult v-if="requeueResult" :slug="slug" :result="requeueResult" :runner-name="options.runnerName" hide-open-link />
      </section>

      <FleetJobProgress :job="job" />
      <FleetJobStories :job="job" />

      <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.runner') }}</dt><dd data-testid="fleet-job-runner">{{ options.runnerName(job.runnerId) ?? t('fleet.jobs.detail.unassigned') }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.requester') }}</dt><dd>{{ people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember') }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.profiles') }}</dt><dd>{{ job.profiles.length > 0 ? job.profiles.join(' > ') : '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.bash') }}</dt><dd data-testid="fleet-job-bash">{{ bashSummary(t, job.bashMode, job.approvalTimeoutSec) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.queuedAt') }}</dt><dd>{{ formatTime(job.queuedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.startedAt') }}</dt><dd>{{ formatTime(job.startedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.finishedAt') }}</dt><dd>{{ formatTime(job.finishedAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.heartbeat') }}</dt><dd>{{ formatTime(job.lastHeartbeatAt) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.finishResult') }}</dt><dd data-testid="fleet-job-finish">{{ job.finishResult ?? '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.branch') }}</dt><dd class="break-all">{{ job.resultBranch ?? '-' }}<template v-if="job.resultSha"> ({{ job.resultSha.slice(0, 12) }})</template><span v-if="wipPush" class="block text-xs text-muted-foreground">{{ wipPush.key === 'failed' ? t('fleet.jobs.detail.wipPush.failed', { reason: wipPush.reason }) : t(`fleet.jobs.detail.wipPush.${wipPush.key}`) }}</span></dd></div>
        <div v-if="job.planFrom"><dt class="text-muted-foreground">{{ t('fleet.jobs.detail.planFrom') }}</dt><dd class="break-all">{{ job.planFrom }}</dd></div>
        <div>
          <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.pr') }}</dt>
          <dd>
            <a v-if="prUrl" :href="prUrl" target="_blank" rel="noopener noreferrer" class="break-all text-primary underline-offset-4 hover:underline" data-testid="fleet-job-pr">{{ prUrl }}</a>
            <span v-else class="break-all">{{ job.resultPrUrl ?? '-' }}</span>
          </dd>
        </div>
      </dl>

      <div v-if="job.escalationReason" class="rounded-md border border-border p-4 text-sm" data-testid="fleet-job-escalation">
        <p class="font-medium">{{ t('fleet.jobs.detail.escalation') }}</p>
        <p class="whitespace-pre-wrap text-muted-foreground">{{ job.escalationReason }}</p>
      </div>

      <FleetJobAnalytics :slug="slug" :job-id="jobId" :reload-key="analyticsReload" />

      <FleetJobApprovals v-if="showApprovals" :slug="slug" :approvals="jobApprovals" :now="now" />

      <FleetJobTimeline :events="events" :has-more="moreEvents" :loading="loadingEvents" :log-attempts="logAttempts" :logs-href="logsHref" @load-more="loadEventsFrom(eventPage + 1)" />

      <Dialog :open="confirmCancel" @update:open="confirmCancel = $event">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{{ t('fleet.jobs.confirmCancel.title') }}</DialogTitle>
            <DialogDescription>{{ t('fleet.jobs.confirmCancel.body') }}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" @click="confirmCancel = false">{{ t('common.cancel') }}</Button>
            <Button variant="destructive" :disabled="busy" data-testid="fleet-job-cancel-confirm" @click="cancelJob()">{{ t('fleet.jobs.actions.cancel') }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </template>
  </div>
</template>
