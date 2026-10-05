<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useAnalyticsPanel } from '~/composables/useAnalyticsPanel'
import { ANALYTICS_TABLE_LIMIT, SPEND_TOP, useFleetAnalytics } from '~/composables/useFleetAnalytics'
import type { WindowQuery } from '~/composables/useFleetAnalytics'
import { useRefetchOnVisible } from '~/composables/useRefetchOnVisible'
import {
  areaRows, assignSlots, chartSeries, costBars, countBars, rateBars, rateRows, rateTableRows, spendTableRows,
} from '~/lib/fleet-analytics-chart'
import { pct, usd } from '~/lib/fleet-analytics-format'
import { parseGroup, parseRange, rangeWindow, routeQuery } from '~/lib/fleet-analytics-range'
import type { RangeState } from '~/lib/fleet-analytics-range'
import { FINISH_OUTCOMES, PROJECT_GROUPS } from '~/lib/fleet-analytics-types'
import type { ProjectGroupBy, QualityAnalyticsDto } from '~/lib/fleet-analytics-types'

definePageMeta({ layout: 'default' })

/** Fleet S2b spec §5.2: where the money goes and what it buys, for one project and one window. */
const DEFAULT_GROUP: ProjectGroupBy = 'model'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const auth = useAuth()
const slug = route.params.project as string
const api = useFleetAnalytics(slug)

const range = computed(() => parseRange(route.query))
const group = computed(() => parseGroup(route.query.group, PROJECT_GROUPS, DEFAULT_GROUP))
const groupOptions = computed(() => PROJECT_GROUPS.map((g) => ({ value: g, label: t(`fleet.analytics.groupBy.${g}`) })))
const win = ref<WindowQuery | null>(null)
const invalidRange = ref(false)
const isAdmin = computed(() => auth.user.value?.role === 'ADMIN')

/** Panels run only after refreshAll set a valid window. */
function current(): WindowQuery {
  if (win.value === null) throw new Error('analytics window not set')
  return win.value
}

const noSeries = (d: { series: unknown[] }): boolean => d.series.length === 0
const noRows = (d: { rows: unknown[] }): boolean => d.rows.length === 0
const noQuality = (d: QualityAnalyticsDto): boolean =>
  d.stories === 0 && d.reviewByReviewer.length === 0 && d.topEscalationReasons.length === 0
  && FINISH_OUTCOMES.every((k) => d.finishOutcomes[k] === 0)

const spend = useAnalyticsPanel(() => api.spend(current(), group.value, SPEND_TOP), noSeries)
const byStage = useAnalyticsPanel(() => api.spend(current(), 'stage'), noSeries)
const byRole = useAnalyticsPanel(() => api.spend(current(), 'role'), noSeries)
const quality = useAnalyticsPanel(() => api.quality(current()), noQuality)
const costlyStories = useAnalyticsPanel(() => api.stories(current(), 'cost', ANALYTICS_TABLE_LIMIT), noRows)
const loopingStories = useAnalyticsPanel(() => api.stories(current(), 'attempts', ANALYTICS_TABLE_LIMIT), noRows)
const costlyJobs = useAnalyticsPanel(() => api.jobs(current(), ANALYTICS_TABLE_LIMIT), noRows)
const ingest = useAnalyticsPanel(() => api.ingest(current()), () => false)
const panels = [spend, byStage, byRole, quality, costlyStories, loopingStories, costlyJobs, ingest]

/** D392: recompute the window (a preset ends now) and refetch every panel; an invalid custom range fetches nothing. */
function refreshAll(): void {
  const next = rangeWindow(range.value, new Date())
  if (!next.ok) {
    invalidRange.value = true
    return
  }
  invalidRange.value = false
  win.value = { from: next.from, to: next.to }
  for (const panel of panels) void panel.run()
}

function setRange(state: RangeState): void {
  void router.replace({ query: routeQuery(state, group.value, DEFAULT_GROUP) })
}

function setGroup(value: string): void {
  void router.replace({ query: routeQuery(range.value, parseGroup(value, PROJECT_GROUPS, DEFAULT_GROUP), DEFAULT_GROUP) })
}

onMounted(refreshAll)
useRefetchOnVisible(refreshAll)
watch(() => JSON.stringify(range.value), refreshAll)
watch(group, () => {
  if (win.value !== null && !invalidRange.value) void spend.run()
})

/** D390: color follows the entity across refetches. */
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

const qualityData = computed(() => quality.data.value)
const firstPass = computed(() => rateRows(qualityData.value?.firstPassSeries ?? []))
const qualityBucket = computed(() => qualityData.value?.bucket ?? 'day')
const rateColumns = computed(() => [t('fleet.analytics.chart.rate')])
const rateTable = computed(() => rateTableRows(firstPass.value, qualityBucket.value))
const rateSummary = computed(() => t('fleet.analytics.chart.rateSummary', { rate: pct(qualityData.value?.firstPassRate) }))
const reviewerBars = computed(() => rateBars((qualityData.value?.reviewByReviewer ?? []).map((r) => ({
  key: r.reviewer,
  label: r.reviewer,
  rate: r.passRate,
  detail: t('fleet.analytics.reviewerDetail', { rate: pct(r.passRate), runs: r.runs }),
}))))
const outcomeBars = computed(() => countBars(FINISH_OUTCOMES.map((k) => ({
  key: k, label: t(`fleet.analytics.outcome.${k}`), count: qualityData.value?.finishOutcomes[k] ?? 0,
}))))
const reasons = computed(() => qualityData.value?.topEscalationReasons ?? [])

/** D393: one API value per tile, `-` until its panel has data. */
const tiles = computed(() => {
  const totals = spend.data.value?.totals
  const q = qualityData.value
  return [
    { id: 'spend', label: t('fleet.analytics.tiles.spend'), value: totals ? usd(totals.costUsd) : '-' },
    { id: 'jobs', label: t('fleet.analytics.tiles.jobs'), value: totals ? String(totals.jobs) : '-' },
    { id: 'median', label: t('fleet.analytics.tiles.median'), value: totals ? usd(totals.medianJobCostUsd) : '-' },
    { id: 'firstPass', label: t('fleet.analytics.tiles.firstPass'), value: q ? pct(q.firstPassRate) : '-' },
    { id: 'escalations', label: t('fleet.analytics.tiles.escalations'), value: q ? String(q.finishOutcomes.escalated) : '-' },
  ]
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.analytics.title')" :subtitle="t('fleet.analytics.subtitle')" />

    <div class="flex flex-wrap items-end justify-between gap-4">
      <FleetAnalyticsRangePicker :model-value="range" :invalid="invalidRange" @update:model-value="setRange" />
      <label class="flex w-48 flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.groupLabel') }}
        <FleetNativeSelect :model-value="group" :options="groupOptions" testid="fleet-analytics-group" @update:model-value="setGroup" />
      </label>
    </div>

    <template v-if="!invalidRange">
    <FleetAnalyticsIngestNotice v-if="ingest.data.value" :pending="ingest.data.value.pending" :failed="ingest.data.value.failed" :admin="isAdmin" />
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

    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.quality')" :status="quality.status.value" testid="fleet-analytics-quality" @retry="quality.run()">
      <div class="grid gap-6 lg:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.firstPass') }}</h3>
          <FleetAnalyticsRateLineChart :rows="firstPass" :bucket="qualityBucket" :label="rateSummary" :series-label="t('fleet.analytics.chart.rate')" />
          <FleetAnalyticsChartDataTable :columns="rateColumns" :rows="rateTable" :caption="rateSummary" testid="fleet-analytics-first-pass-data" />
        </div>
        <div class="space-y-4">
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.reviewers') }}</h3>
            <FleetAnalyticsBarList :rows="reviewerBars" :label="t('fleet.analytics.panels.reviewers')" testid="fleet-analytics-reviewers" />
          </div>
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.outcomes') }}</h3>
            <FleetAnalyticsBarList :rows="outcomeBars" :label="t('fleet.analytics.panels.outcomes')" testid="fleet-analytics-outcomes" />
          </div>
          <div class="space-y-2">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.panels.reasons') }}</h3>
            <ol class="space-y-1 text-sm" data-testid="fleet-analytics-reasons">
              <li v-for="r in reasons" :key="r.reason" class="flex justify-between gap-3">
                <span class="min-w-0 break-words">{{ r.reason }}</span>
                <span class="shrink-0 text-muted-foreground">{{ t('fleet.analytics.reasonCount', { count: r.count }) }}</span>
              </li>
            </ol>
          </div>
        </div>
      </div>
    </FleetAnalyticsPanel>

    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.expensiveStories')" :status="costlyStories.status.value" testid="fleet-analytics-costly-stories" @retry="costlyStories.run()">
      <FleetAnalyticsStoryTable :slug="slug" :rows="costlyStories.data.value?.rows ?? []" testid="fleet-analytics-costly-stories-table" />
    </FleetAnalyticsPanel>
    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.loopingStories')" :status="loopingStories.status.value" testid="fleet-analytics-looping-stories" @retry="loopingStories.run()">
      <FleetAnalyticsStoryTable :slug="slug" :rows="loopingStories.data.value?.rows ?? []" testid="fleet-analytics-looping-stories-table" />
    </FleetAnalyticsPanel>
    <FleetAnalyticsPanel :title="t('fleet.analytics.panels.expensiveJobs')" :status="costlyJobs.status.value" testid="fleet-analytics-costly-jobs" @retry="costlyJobs.run()">
      <FleetAnalyticsJobTable :slug="slug" :rows="costlyJobs.data.value?.rows ?? []" testid="fleet-analytics-costly-jobs-table" />
    </FleetAnalyticsPanel>
    </template>
  </div>
</template>
