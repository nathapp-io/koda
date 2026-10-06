<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useFleetAnalytics } from '~/composables/useFleetAnalytics'
import { costBars } from '~/lib/fleet-analytics-chart'
import { ingestVariant, skippedFiles, usd } from '~/lib/fleet-analytics-format'
import type { JobAnalyticsDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/**
 * Fleet S2b spec §5.4, D396: the job's cost and quality once its bundle is ingested. `reloadKey` is bumped by the
 * page on every live reload; a failed fetch keeps what is shown and offers a retry, never a toast.
 */
const props = defineProps<{ slug: string; jobId: string; reloadKey: number }>()
const { t, te } = useI18n()
const api = useFleetAnalytics(props.slug)

const data = ref<JobAnalyticsDto | null>(null)
const failed = ref(false)
let latest = 0

async function load(): Promise<void> {
  const id = ++latest
  try {
    const next = await api.job(props.jobId)
    if (id !== latest) return
    data.value = next
    failed.value = false
  } catch {
    if (id !== latest) return
    failed.value = true
  }
}

onMounted(load)
watch(() => props.reloadKey, load)

const ingest = computed(() => data.value?.ingest ?? null)
const statusLabel = computed(() => (ingest.value ? codeLabel(t, te, 'fleet.analytics.ingestStatus', ingest.value.status) : ''))
const skipped = computed(() => (ingest.value ? skippedFiles(ingest.value.files) : ''))
const showLedger = computed(() => {
  const d = data.value
  return d !== null && d.liveCostUsd !== null && d.ledgerCostUsd !== null && d.liveCostUsd !== d.ledgerCostUsd
})
const otherLabel = computed(() => t('fleet.analytics.other'))
const blocks = computed(() => [
  { id: 'stage', title: t('fleet.analytics.job.byStage'), rows: costBars(data.value?.byStage ?? [], otherLabel.value) },
  { id: 'role', title: t('fleet.analytics.job.byRole'), rows: costBars(data.value?.byRole ?? [], otherLabel.value) },
  { id: 'model', title: t('fleet.analytics.job.byModel'), rows: costBars(data.value?.byModel ?? [], otherLabel.value) },
])
const yesNo = (v: boolean): string => (v ? t('fleet.analytics.table.yes') : t('fleet.analytics.table.no'))
function severityText(counts: Readonly<Record<string, number>>): string {
  const found = Object.entries(counts).filter(([, n]) => n > 0)
  return found.length === 0 ? t('fleet.analytics.job.noFindings') : found.map(([severity, n]) => `${severity} ${n}`).join(', ')
}
</script>

<template>
  <section v-if="ingest" class="space-y-4" data-testid="fleet-job-analytics" :data-ingest="ingest.status">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-medium">{{ t('fleet.analytics.job.title') }}</h2>
      <Badge :variant="ingestVariant(ingest.status)" data-testid="fleet-job-analytics-ingest">{{ t('fleet.analytics.job.analysis') }}: {{ statusLabel }}</Badge>
      <Button variant="ghost" size="sm" data-testid="fleet-job-analytics-reload" @click="load()">{{ t('fleet.analytics.job.refresh') }}</Button>
    </div>

    <div v-if="failed" class="flex flex-wrap items-center gap-2 text-sm" role="alert" data-testid="fleet-job-analytics-error">
      <span class="text-status-rejected">{{ t('fleet.analytics.job.loadFailed') }}</span>
      <Button variant="outline" size="sm" data-testid="fleet-job-analytics-retry" @click="load()">{{ t('common.retry') }}</Button>
    </div>
    <p v-if="ingest.status === 'partial' && skipped" class="text-sm text-muted-foreground" data-testid="fleet-job-analytics-files">{{ t('fleet.analytics.job.files', { files: skipped }) }}</p>
    <p v-if="ingest.status === 'failed' && ingest.error" class="whitespace-pre-wrap text-sm text-status-rejected" data-testid="fleet-job-analytics-ingest-error">{{ ingest.error }}</p>
    <p v-if="data?.corrected" class="text-sm" data-testid="fleet-job-analytics-corrected">{{ t('fleet.analytics.job.corrected') }}</p>
    <p v-if="showLedger" class="text-sm text-muted-foreground" data-testid="fleet-job-analytics-ledger">{{ t('fleet.analytics.job.liveLedger', { live: usd(data?.liveCostUsd), ledger: usd(data?.ledgerCostUsd) }) }}</p>

    <div class="grid gap-4 md:grid-cols-3">
      <template v-for="block in blocks" :key="block.id">
        <div v-if="block.rows.length > 0" class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">{{ block.title }}</h3>
          <FleetAnalyticsBarList :rows="block.rows" :label="block.title" :testid="`fleet-job-analytics-${block.id}`" />
        </div>
      </template>
    </div>

    <div v-if="data && data.stories.length > 0" class="space-y-2">
      <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.job.stories') }}</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
              <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.attempts') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.firstPass') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.success') }}</th>
              <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="story in data.stories" :key="`${story.leaseEpoch}:${story.storyId}`" data-testid="fleet-job-analytics-story">
              <td class="py-1 font-mono text-xs">{{ story.storyId }}</td>
              <td class="py-1 text-right tabular-nums">{{ story.attempts }}</td>
              <td class="py-1">{{ yesNo(story.firstPassSuccess) }}</td>
              <td class="py-1">{{ yesNo(story.success) }}</td>
              <td class="py-1 text-right tabular-nums">{{ usd(story.costUsd) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="data && data.reviews.length > 0" class="space-y-2">
      <h3 class="text-xs font-medium text-muted-foreground">{{ t('fleet.analytics.job.reviews') }}</h3>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.reviewer') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.passed') }}</th>
              <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.job.findings') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(review, i) in data.reviews" :key="`${review.at}:${i}`" data-testid="fleet-job-analytics-review">
              <td class="py-1 break-all">{{ review.reviewer }}</td>
              <td class="py-1 font-mono text-xs">{{ review.storyId ?? '-' }}</td>
              <td class="py-1">{{ yesNo(review.passed) }}</td>
              <td class="py-1">{{ severityText(review.findingsBySeverity) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
