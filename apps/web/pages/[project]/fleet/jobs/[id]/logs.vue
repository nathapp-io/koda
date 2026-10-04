<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { entriesQuery, hasActiveFilter, logViewQuery, parseLogViewQuery, type LogFilters, type LogViewParams } from '~/lib/fleet-log-query'
import { LOG_STREAMS, type FleetJobLogListDto, type LogStream } from '~/lib/fleet-log-types'
import { createLogViewer, type LogViewer, type LogViewerState } from '~/lib/fleet-log-viewer'
import { formatBytes, isNearBottom, logNotices } from '~/lib/fleet-log-view'
import { isActiveJobState, isTerminalJobState } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'
import FleetLogFilters from '~/components/fleet/FleetLogFilters.vue'
import FleetLogNotices from '~/components/fleet/FleetLogNotices.vue'
import FleetLogRows from '~/components/fleet/FleetLogRows.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const router = useRouter()
const slug = route.params.project as string
const jobId = route.params.id as string
const { t } = useI18n()
const jobsApi = useFleetJobs(slug)
const logsApi = useFleetJobLogs(slug, jobId)

const job = ref<FleetJobDto | null>(null)
const list = ref<FleetJobLogListDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const state = ref<LogViewerState | null>(null)
/** D355: the attempt the open viewer reads; fixed until the user picks another (a requeue never switches it). */
const activeEpoch = ref<number | null>(null)
const scroller = ref<HTMLElement | null>(null)
let viewer: LogViewer | null = null

const params = computed<LogViewParams>(() => parseLogViewQuery(route.query as Record<string, string | string[] | null>))
const attempt = computed(() => list.value?.attempts.find((a) => a.leaseEpoch === activeEpoch.value) ?? null)
const summary = computed(() => attempt.value?.streams.find((s) => s.stream === params.value.stream) ?? null)
const view = computed(() => state.value?.view ?? null)
const filtered = computed(() => hasActiveFilter(params.value.stream, params.value.filters))
const stories = computed(() => (job.value?.stories ?? []).map((s) => s.id))
const attemptOptions = computed(() => {
  const epochs = list.value?.attempts.map((a) => a.leaseEpoch) ?? []
  const all = activeEpoch.value === null || epochs.includes(activeEpoch.value) ? epochs : [activeEpoch.value, ...epochs]
  return all.map((epoch) => ({ value: String(epoch), label: t('fleet.logs.attemptOption', { epoch }) }))
})
const notices = computed(() => logNotices({
  summary: summary.value,
  legacySampled: attempt.value?.legacySampled ?? false,
  view: view.value,
  jobTerminal: job.value !== null && isTerminalJobState(job.value.state),
  expired: state.value?.expired ?? false,
}))
const downloadHref = computed(() => (activeEpoch.value !== null && summary.value && !summary.value.expired && summary.value.sizeBytes > 0
  ? logsApi.downloadHref(params.value.stream, activeEpoch.value)
  : null))
const timelineHref = `/${slug}/fleet/jobs/${jobId}#timeline`

/** Final review #2 (D355): a tab or filter change keeps the attempt being read, even after a requeue reorders the list. */
function navigate(next: LogViewParams): void {
  void router.replace({ query: logViewQuery({ ...next, epoch: next.epoch ?? activeEpoch.value }) })
}
const selectStream = (stream: LogStream): void => navigate({ ...params.value, stream })
const selectAttempt = (value: string): void => navigate({ ...params.value, epoch: Number(value) })
const updateFilters = (filters: LogFilters): void => navigate({ ...params.value, filters })

async function scrollToEnd(): Promise<void> {
  await nextTick()
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
}

/** One viewer per (stream, attempt, filters): a change disposes the old one, so its late answers are dropped. */
function startViewer(): void {
  viewer?.dispose()
  const current = job.value
  if (!current) return
  const p = params.value
  const epoch = p.epoch ?? list.value?.attempts[0]?.leaseEpoch ?? current.leaseEpoch
  activeEpoch.value = epoch
  state.value = null
  const next = createLogViewer({
    fetchPage: (page) => logsApi.entries(p.stream, entriesQuery(p, epoch, page)),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    filtered: hasActiveFilter(p.stream, p.filters),
    onChange: (s) => {
      state.value = s
      if (s.follow) void scrollToEnd()
    },
    describeError: extractApiError,
  }, { follow: isActiveJobState(current.state) })
  viewer = next
  void next.open()
}

function onScroll(): void {
  const el = scroller.value
  if (el && state.value?.follow && !isNearBottom(el)) viewer?.setFollow(false)
}

async function loadList(): Promise<void> {
  list.value = await logsApi.list()
}

async function load(): Promise<void> {
  pending.value = true
  try {
    const [loadedJob] = await Promise.all([jobsApi.get(jobId), loadList()])
    job.value = loadedJob
    loadFailed.value = false
    startViewer()
  }
  catch {
    loadFailed.value = true
  }
  finally {
    pending.value = false
  }
}

onMounted(load)
watch(() => route.fullPath, () => { if (job.value) startViewer() })

/** Live (spec §4.1): never flips `pending`; a failure waits for the next event. */
const jobReload = createDebouncer(() => { void jobsApi.get(jobId).then((j) => { job.value = j }).catch(() => undefined) }, 300)
const listReload = createDebouncer(() => { void loadList().catch(() => undefined) }, 300)
onBeforeUnmount(() => {
  viewer?.dispose()
  jobReload.cancel()
  listReload.cancel()
})
useProjectEvents(slug, {
  onFleetLog: (event) => {
    if (event.jobId !== jobId) return
    if (event.leaseEpoch === activeEpoch.value && event.stream === params.value.stream) void viewer?.onGrowth()
    const known = list.value?.attempts.some((a) => a.leaseEpoch === event.leaseEpoch && a.streams.some((s) => s.stream === event.stream)) ?? false
    if (event.complete || !known) listReload.trigger()
  },
  onFleetJob: (event) => {
    if (event.jobId === jobId) jobReload.trigger()
  },
  onResync: () => {
    jobReload.trigger()
    listReload.trigger()
    void viewer?.onGrowth()
  },
})
</script>

<template>
  <div class="space-y-4">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !job" @retry="load()" />
    <template v-else>
      <PageHeader :title="t('fleet.logs.title')" :subtitle="`${job.feature} | ${job.command}`">
        <template #actions>
          <a
            v-if="downloadHref"
            :href="downloadHref"
            download
            class="inline-flex h-9 items-center rounded-md border border-input px-3 text-sm hover:bg-muted"
            data-testid="fleet-log-download"
          >{{ t('fleet.logs.download') }}</a>
          <NuxtLink :to="`/${slug}/fleet/jobs/${jobId}`" class="inline-flex h-9 items-center px-3 text-sm text-primary underline-offset-4 hover:underline" data-testid="fleet-log-back">
            {{ t('fleet.logs.back') }}
          </NuxtLink>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-center gap-3">
        <div class="flex gap-1" role="tablist">
          <Button
            v-for="stream in LOG_STREAMS"
            :key="stream"
            role="tab"
            size="sm"
            :variant="stream === params.stream ? 'default' : 'outline'"
            :aria-selected="stream === params.stream"
            :data-testid="`fleet-log-tab-${stream}`"
            @click="selectStream(stream)"
          >
            {{ t(`fleet.logs.streams.${stream}`) }}
          </Button>
        </div>
        <label v-if="attemptOptions.length > 1" class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ t('fleet.logs.attempt') }}</span>
          <FleetNativeSelect :model-value="String(activeEpoch)" :options="attemptOptions" testid="fleet-log-attempt" @update:model-value="selectAttempt($event)" />
        </label>
      </div>

      <FleetLogFilters :stream="params.stream" :filters="params.filters" :stories="stories" @update="updateFilters($event)" />
      <FleetLogNotices :notices="notices" :timeline-href="timelineHref" :truncated-at="view?.size ?? summary?.sizeBytes ?? 0" />

      <p v-if="state?.rateLimited" class="text-sm text-muted-foreground" data-testid="fleet-log-rate-limited">{{ t('fleet.logs.rateLimited') }}</p>
      <p v-if="state?.error" class="text-sm text-destructive" data-testid="fleet-log-error">{{ state.error }}</p>

      <section v-if="!state?.expired" class="rounded-md border border-border">
        <div class="flex items-center justify-end gap-2 border-b border-border px-2 py-1 text-xs">
          <span v-if="state?.follow" class="text-muted-foreground" data-testid="fleet-log-following">{{ t('fleet.logs.following') }}</span>
          <Button v-else variant="ghost" size="sm" :disabled="state?.loading" data-testid="fleet-log-jump" @click="viewer?.jumpToLatest()">
            {{ t('fleet.logs.jumpToLatest') }}
          </Button>
        </div>
        <div ref="scroller" class="max-h-[70vh] overflow-auto" data-testid="fleet-log-scroller" @scroll="onScroll()">
          <div v-if="view && !view.atStart" class="p-2">
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-earlier" @click="viewer?.loadEarlier()">{{ t('fleet.logs.loadEarlier') }}</Button>
          </div>
          <p v-if="view?.searching?.direction === 'backward'" class="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground" data-testid="fleet-log-searching">
            {{ t('fleet.logs.searching.backward', { scanned: formatBytes(view.searching.scannedFrom), size: formatBytes(view.size) }) }}
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-keep-searching" @click="viewer?.keepSearching()">{{ t('fleet.logs.searching.keep') }}</Button>
          </p>
          <FleetLogRows v-if="view" :stream="params.stream" :rows="view.rows" />
          <p v-if="view && view.rows.length === 0 && !view.searching" class="p-4 text-sm text-muted-foreground" data-testid="fleet-log-empty">
            {{ filtered ? t('fleet.logs.emptyFiltered') : t('fleet.logs.empty') }}
          </p>
          <p v-if="view?.searching?.direction === 'forward'" class="flex flex-wrap items-center gap-2 p-2 text-sm text-muted-foreground" data-testid="fleet-log-searching">
            {{ t('fleet.logs.searching.forward', { scanned: formatBytes(view.searching.scannedTo), size: formatBytes(view.size) }) }}
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-keep-searching" @click="viewer?.keepSearching()">{{ t('fleet.logs.searching.keep') }}</Button>
          </p>
          <div v-else-if="view && !view.atEnd && !state?.follow" class="p-2">
            <Button variant="outline" size="sm" :disabled="state?.loading" data-testid="fleet-log-more" @click="viewer?.loadMore()">{{ t('fleet.logs.loadMore') }}</Button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
