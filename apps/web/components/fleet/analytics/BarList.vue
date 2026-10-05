<script setup lang="ts">
import type { BarRow } from '~/lib/fleet-analytics-chart'

/** One measure across categories (D390): a single hue, value text beside every bar, the title as tooltip. */
defineProps<{ rows: readonly BarRow[]; testid: string; label: string }>()
</script>

<template>
  <ul class="space-y-2 text-sm" :data-testid="testid" :aria-label="label">
    <li
      v-for="row in rows"
      :key="row.key"
      class="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3"
      :title="`${row.label}: ${row.value}`"
      :data-testid="`${testid}-row`"
      :data-key="row.key"
      :data-share="row.share"
    >
      <span class="truncate">{{ row.label }}</span>
      <span class="h-2 rounded-sm bg-muted" aria-hidden="true">
        <span class="block h-2 rounded-sm" :style="{ width: `${Math.round(row.share * 1000) / 10}%`, backgroundColor: 'var(--chart-1)' }" />
      </span>
      <span class="tabular-nums" :data-testid="`${testid}-value`">{{ row.value }}</span>
    </li>
  </ul>
</template>
