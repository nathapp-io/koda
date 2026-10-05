<script setup lang="ts">
import { computed } from 'vue'
import { VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'
import { rateHtml } from '~/lib/fleet-analytics-chart'
import type { RateRow } from '~/lib/fleet-analytics-chart'
import { bucketLabel } from '~/lib/fleet-analytics-format'
import type { AnalyticsBucket } from '~/lib/fleet-analytics-types'

/** Spec §5.2: first-pass rate per bucket; a bucket with no stories is a gap. Single series, no legend. */
const props = defineProps<{ rows: readonly RateRow[]; bucket: AnalyticsBucket; label: string; seriesLabel: string }>()

const data = computed(() => [...props.rows])
const x = (d: RateRow): number => d.t
const y = (d: RateRow): number | undefined => d.rate
const ms = (v: number | Date): number => (v instanceof Date ? v.getTime() : v)
const xTick = (v: number | Date): string => bucketLabel(ms(v), props.bucket)
const yTick = (v: number | Date): string => `${Math.round(ms(v) * 100)}%`
const template = (d: RateRow): string => rateHtml(d, props.bucket, props.seriesLabel)
</script>

<template>
  <div role="img" :aria-label="label" data-testid="fleet-analytics-first-pass-chart">
    <VisXYContainer :data="data" :height="180" :y-domain="[0, 1]">
      <VisLine :x="x" :y="y" color="var(--chart-1)" />
      <VisAxis type="x" :tick-format="xTick" :num-ticks="6" :grid-line="false" />
      <VisAxis type="y" :tick-format="yTick" :num-ticks="3" />
      <VisCrosshair :template="template" color="var(--chart-1)" />
      <VisTooltip />
    </VisXYContainer>
  </div>
</template>
