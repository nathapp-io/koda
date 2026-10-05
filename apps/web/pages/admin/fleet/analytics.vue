<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'
import { SPEND_TOP, useFleetAnalyticsAdmin } from '~/composables/useFleetAnalytics'
import type { WindowQuery } from '~/composables/useFleetAnalytics'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useRefetchOnVisible } from '~/composables/useRefetchOnVisible'
import { areaRows, assignSlots, chartSeries, costBars, spendTableRows } from '~/lib/fleet-analytics-chart'
import { pct, usd } from '~/lib/fleet-analytics-format'
import { parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import type { RangeState } from '~/lib/fleet-analytics-range'
import { ADMIN_GROUPS, INGEST_STATUSES } from '~/lib/fleet-analytics-types'
import type { AdminGroupBy, IngestRowDto, IngestStatus } from '~/lib/fleet-analytics-types'
import type { FleetPage } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** Fleet S2b spec §5.3, D395: spend across projects and bundle ingest health (global ADMIN). No polling. */
const DEFAULT_GROUP: AdminGroupBy = 'project'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const toast = useAppToast()
const api = useFleetAnalyticsAdmin()

const range = computed(() => parseRange(route.query))
const group = computed(() => parseGroup(route.query.group, ADMIN_GROUPS, DEFAULT_GROUP))
const groupOptions = computed(() => ADMIN_GROUPS.map((g) => ({ value: g, label: t(`fleet.analytics.groupBy.${g}`) })))
const win = ref<WindowQuery | null>(null)
const invalidRange = ref(false)
const forbidden = ref(false)

function current(): WindowQuery {
  if (win.value === null) throw new Error('analytics window not set')
  return win.value
}

const noSeries = (d: { series: unknown[] }): boolean => d.series.length === 0
const spend = useAnalyticsPanel(() => api.spend(current(), group.value, SPEND_TOP), noSeries)
const byStage = useAnalyticsPanel(() => api.spend(current(), 'stage'), noSeries)
const byRole = useAnalyticsPanel(() => api.spend(current(), 'role'), noSeries)

const statusFilter = ref('')
const page = ref(1)
const ingestPage = shallowRef<FleetPage<IngestRowDto> | null>(null)
const ingestFailed = ref(false)
const busyJobId = ref<string | null>(null)
const busyAll = ref(false)
const statusOptions = computed(() => [
  { value: '', label: t('fleet.analytics.ingest.all') },
  ...INGEST_STATUSES.map((s) => ({ value: s, label: t(`fleet.analytics.ingestStatus.${s}`) })),
])
const asStatus = (value: string): IngestStatus | undefined => INGEST_STATUSES.find((s) => s === value)

/** A 403 means the viewer is not a global admin: the page shows the admin-only note (as admin budgets). */
async function refreshIngest(): Promise<void> {
  try {
    ingestPage.value = await api.ingestList(asStatus(statusFilter.value), page.value)
    ingestFailed.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      forbidden.value = true
      return
    }
    ingestFailed.value = true
  }
}

function refreshAll(): void {
  const next = rangeWindow(range.value, new Date())
  if (next.ok) {
    invalidRange.value = false
    win.value = { from: next.from, to: next.to }
    for (const panel of [spend, byStage, byRole]) void panel.run()
  } else {
    invalidRange.value = true
  }
  void refreshIngest()
}

function setRange(state: RangeState): void {
  void router.replace({ query: routeQuery(state, group.value, DEFAULT_GROUP) })
}

function setGroup(value: string): void {
  void router.replace({ query: routeQuery(range.value, parseGroup(value, ADMIN_GROUPS, DEFAULT_GROUP), DEFAULT_GROUP) })
}

function setStatus(value: string): void {
  statusFilter.value = value
  page.value = 1
  void refreshIngest()
}

function go(delta: number): void {
  page.value = Math.max(1, page.value + delta)
  void refreshIngest()
}

async function rerun(jobId: string): Promise<void> {
  busyJobId.value = jobId
  try {
    const result = await api.rerun(jobId)
    toast.success(t('fleet.analytics.ingest.queued', { n: result.queued }))
    await refreshIngest()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    busyJobId.value = null
  }
}

async function bulk(action: 'backfill' | 'rerunOutdated'): Promise<void> {
  if (action === 'rerunOutdated' && !window.confirm(t('fleet.analytics.ingest.confirmRerunOutdated'))) return
  busyAll.value = true
  try {
    const result = action === 'backfill' ? await api.backfill() : await api.rerunOutdated()
    toast.success(t('fleet.analytics.ingest.queued', { n: result.queued }))
    await refreshIngest()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    busyAll.value = false
  }
}

onMounted(refreshAll)
useRefetchOnVisible(refreshAll)
watch(() => JSON.stringify(range.value), refreshAll)
watch(group, () => {
  if (win.value !== null && !invalidRange.value) void spend.run()
})

const slots = shallowRef(new Map<string, number>())
watch(() => spend.data.value, (data) => {
  slots.value = assignSlots(slots.value, (data?.series ?? []).filter((s) => !s.folded).map((s) => s.key))
})
const otherLabel = computed(() => t('fleet.analytics.other'))
const spendSeries = computed(() => chartSeries(spend.data.value?.series ?? [], slots.value, otherLabel.value))
const spendRows = computed(() => areaRows(spend.data.value?.series ?? []))
const spendBucket = computed(() => spend.data.value?.bucket ?? 'day')
const spendColumns = computed(() => spendSeries.value.map((s) => s.label))
const spendTable = computed(() => spendTableRows(spendRows.value, spendBucket.value))
const spendSummary = computed(() =>
  t('fleet.analytics.chart.spendSummary', { total: usd(spend.data.value?.totals.costUsd), count: spendSeries.value.length }))
const stageBars = computed(() => costBars(byStage.data.value?.series ?? [], otherLabel.value))
const roleBars = computed(() => costBars(byRole.data.value?.series ?? [], otherLabel.value))

const tiles = computed(() => {
  const totals = spend.data.value?.totals
  return [
    { id: 'spend', label: t('fleet.analytics.tiles.spend'), value: totals ? usd(totals.costUsd) : '-' },
    { id: 'jobs', label: t('fleet.analytics.tiles.jobs'), value: totals ? String(totals.jobs) : '-' },
    { id: 'median', label: t('fleet.analytics.tiles.median'), value: totals ? usd(totals.medianJobCostUsd) : '-' },
    { id: 'cacheShare', label: t('fleet.analytics.tiles.cacheShare'), value: totals ? pct(totals.cacheShare) : '-' },
  ]
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.analytics.title')" :subtitle="t('fleet.analytics.subtitleAdmin')" />

    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-analytics-admin-only">{{ t('fleet.common.adminOnly') }}</p>
    <template v-else>
      <div class="flex flex-wrap items-end justify-between gap-4">
        <FleetAnalyticsRangePicker :model-value="range" :invalid="invalidRange" @update:model-value="setRange" />
        <label class="flex w-48 flex-col gap-1 text-xs text-muted-foreground">
          {{ t('fleet.analytics.groupLabel') }}
          <FleetNativeSelect :model-value="group" :options="groupOptions" testid="fleet-analytics-group" @update:model-value="setGroup" />
        </label>
      </div>

      <template v-if="!invalidRange">
      <FleetAnalyticsSummaryTiles :tiles="tiles" />

      <FleetAnalyticsPanel :title="t('fleet.analytics.panels.spend')" :status="spend.status.value" :empty-text="t('fleet.analytics.empty')" testid="fleet-analytics-spend" @retry="spend.run()">
        <FleetAnalyticsSpendAreaChart :rows="spendRows" :series="spendSeries" :bucket="spendBucket" :label="spendSummary" />
        <FleetAnalyticsSeriesLegend :series="spendSeries" testid="fleet-analytics-legend" />
        <FleetAnalyticsChartDataTable :columns="spendColumns" :rows="spendTable" :caption="spendSummary" testid="fleet-analytics-spend-data" />
      </FleetAnalyticsPanel>

      <div class="grid gap-6 lg:grid-cols-2">
        <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byStage')" :status="byStage.status.value" testid="fleet-analytics-stage" @retry="byStage.run()">
          <FleetAnalyticsBarList :rows="stageBars" :label="t('fleet.analytics.panels.byStage')" testid="fleet-analytics-stage-bars" />
        </FleetAnalyticsPanel>
        <FleetAnalyticsPanel :title="t('fleet.analytics.panels.byRole')" :status="byRole.status.value" testid="fleet-analytics-role" @retry="byRole.run()">
          <FleetAnalyticsBarList :rows="roleBars" :label="t('fleet.analytics.panels.byRole')" testid="fleet-analytics-role-bars" />
        </FleetAnalyticsPanel>
      </div>
      </template>

      <section class="space-y-3 rounded-md border border-border p-4" data-testid="fleet-ingest">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <h2 class="text-sm font-medium">{{ t('fleet.analytics.ingest.title') }}</h2>
          <div class="flex flex-wrap items-end gap-2">
            <label class="flex w-44 flex-col gap-1 text-xs text-muted-foreground">
              {{ t('fleet.analytics.ingest.statusFilter') }}
              <FleetNativeSelect :model-value="statusFilter" :options="statusOptions" testid="fleet-ingest-status" @update:model-value="setStatus" />
            </label>
            <Button variant="outline" size="sm" :disabled="busyAll" data-testid="fleet-ingest-backfill" @click="bulk('backfill')">{{ t('fleet.analytics.ingest.backfill') }}</Button>
            <Button variant="outline" size="sm" :disabled="busyAll" data-testid="fleet-ingest-rerun-outdated" @click="bulk('rerunOutdated')">{{ t('fleet.analytics.ingest.rerunOutdated') }}</Button>
          </div>
        </div>
        <ErrorState v-if="ingestFailed" @retry="refreshIngest()" />
        <LoadingState v-else-if="ingestPage === null" />
        <p v-else-if="ingestPage.records.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-ingest-empty">{{ t('fleet.analytics.ingest.empty') }}</p>
        <template v-else>
          <FleetAnalyticsIngestTable :rows="ingestPage.records" :busy-job-id="busyJobId" @rerun="rerun" />
          <div class="flex items-center justify-between text-sm text-muted-foreground">
            <span>{{ t('fleet.analytics.ingest.total', { total: ingestPage.total }) }}</span>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" :disabled="!ingestPage.hasPrev" data-testid="fleet-ingest-prev" @click="go(-1)">{{ t('fleet.analytics.ingest.previous') }}</Button>
              <Button variant="outline" size="sm" :disabled="!ingestPage.hasNext" data-testid="fleet-ingest-next" @click="go(1)">{{ t('fleet.analytics.ingest.next') }}</Button>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>
