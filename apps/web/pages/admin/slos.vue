<script setup lang="ts">
import { Activity } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
const toast = useAppToast()
const { $api } = useApi()

interface SloMetric {
  label: string
  value: number
}

interface SloResponse {
  retrievalLatency: {
    p50: number
    p95: number
    p99: number
    sampleCount: number
  }
  staleHitRate: number
  provenanceCoverage: number
  leakageIncidents: number
  memoryGrowthRate: number
}

function flattenSloMetrics(response: SloResponse, t: (key: string) => string): SloMetric[] {
  const lat = response.retrievalLatency ?? { p50: 0, p95: 0, p99: 0, sampleCount: 0 }
  return [
    { label: t('slos.metrics.retrievalLatencyP50'), value: lat.p50 },
    { label: t('slos.metrics.retrievalLatencyP95'), value: lat.p95 },
    { label: t('slos.metrics.retrievalLatencyP99'), value: lat.p99 },
    { label: t('slos.metrics.retrievalLatencySamples'), value: lat.sampleCount },
    { label: t('slos.metrics.staleHitRate'), value: response.staleHitRate },
    { label: t('slos.metrics.provenanceCoverage'), value: response.provenanceCoverage },
    { label: t('slos.metrics.leakageIncidents'), value: response.leakageIncidents },
    { label: t('slos.metrics.memoryGrowthRate'), value: response.memoryGrowthRate },
  ]
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function defaultWindow(): { from: string; to: string } {
  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  return { from: toIsoDate(thirtyDaysAgo), to: toIsoDate(now) }
}

const initialWindow = defaultWindow()
const from = ref(initialWindow.from)
const to = ref(initialWindow.to)

const metrics = ref<SloMetric[]>([])
const pending = ref(false)
const adminOnly = ref(false)
let latestRequestId = 0

async function reload() {
  const requestId = ++latestRequestId
  pending.value = true
  adminOnly.value = false
  metrics.value = []
  try {
    const response = await $api.get<SloResponse>('/admin/slos', {
      query: { from: from.value, to: to.value },
    })
    if (requestId !== latestRequestId) return
    metrics.value = flattenSloMetrics(response, t)
  }
  catch (err: unknown) {
    if (requestId !== latestRequestId) return
    if (err instanceof ApiError && err.code === 403) {
      adminOnly.value = true
      return
    }
    toast.error(extractApiError(err))
  }
  finally {
    if (requestId === latestRequestId) {
      pending.value = false
    }
  }
}

onMounted(reload)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('slos.title')">
      <template #icon>
        <Activity class="h-5 w-5" />
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-end gap-3">
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('slos.window.from') }}</label>
        <input
          v-model="from"
          type="date"
          class="rounded-md border border-border bg-background px-2 py-1 text-sm"
          @change="reload"
        >
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-xs font-medium text-muted-foreground">{{ t('slos.window.to') }}</label>
        <input
          v-model="to"
          type="date"
          class="rounded-md border border-border bg-background px-2 py-1 text-sm"
          @change="reload"
        >
      </div>
    </div>

    <LoadingState v-if="pending" />

    <div
      v-else-if="adminOnly"
      class="rounded-lg border border-dashed border-border py-16 text-center"
    >
      <p class="text-sm font-medium text-muted-foreground">{{ t('slos.adminOnly') }}</p>
    </div>

    <div v-else-if="metrics.length === 0" class="rounded-lg border border-dashed border-border py-16 text-center">
      <p class="text-sm font-medium text-muted-foreground">{{ t('slos.empty') }}</p>
    </div>

    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div
        v-for="metric in metrics"
        :key="metric.label"
        class="rounded-lg border border-border bg-background p-4"
        data-testid="slo-metric-card"
      >
        <p class="text-xs font-medium text-muted-foreground">{{ metric.label }}</p>
        <p class="mt-2 text-2xl font-semibold text-foreground">{{ metric.value }}</p>
      </div>
    </div>
  </div>
</template>
