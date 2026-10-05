<script setup lang="ts">
import { computed } from 'vue'
import { VisArea, VisAxis, VisCrosshair, VisTooltip, VisXYContainer } from '@unovis/vue'
import { crosshairHtml } from '~/lib/fleet-analytics-chart'
import type { AreaRow, ChartSeries } from '~/lib/fleet-analytics-chart'
import { axisUsd, bucketLabel } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** Spec §5.1-5.2: stacked spend per group over time. Client-only: unovis needs the DOM. */
const props = defineProps<{ rows: readonly AreaRow[]; series: readonly ChartSeries[]; bucket: AnalyticsBucket; label: string }>()

const data = computed(() => [...props.rows])
const x = (d: AreaRow): number => d.t
const y = computed(() => props.series.map((_, i) => (d: AreaRow): number => d.values[i] ?? 0))
const color = (_d: unknown, i: number): string => props.series[i]?.color ?? 'var(--chart-other)'
const ms = (v: number | Date): number => (v instanceof Date ? v.getTime() : v)
const xTick = (v: number | Date): string => bucketLabel(ms(v), props.bucket)
const yTick = (v: number | Date): string => axisUsd(ms(v))
const template = (d: AreaRow): string => crosshairHtml(d, props.series, props.bucket)
</script>

<template>
  <div role="img" :aria-label="label" data-testid="fleet-analytics-spend-chart">
    <VisXYContainer :data="data" :height="240">
      <VisArea :x="x" :y="y" :color="color" />
      <VisAxis type="x" :tick-format="xTick" :num-ticks="6" :grid-line="false" />
      <VisAxis type="y" :tick-format="yTick" :num-ticks="4" />
      <VisCrosshair :template="template" :color="color" />
      <VisTooltip />
    </VisXYContainer>
  </div>
</template>
