<script setup lang="ts">
import type { TableRow } from '~/lib/fleet-analytics-chart'

/** Spec §5.5: every chart's numbers are also available as a table. */
defineProps<{ columns: readonly string[]; rows: readonly TableRow[]; caption: string; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <details class="text-sm" :data-testid="testid">
    <summary class="cursor-pointer text-muted-foreground">{{ t('fleet.analytics.chart.showData') }}</summary>
    <div class="mt-2 overflow-x-auto">
      <table class="w-full">
        <caption class="sr-only">{{ caption }}</caption>
        <thead>
          <tr class="text-muted-foreground">
            <th scope="col" class="py-1 text-left font-normal">{{ t('fleet.analytics.chart.bucket') }}</th>
            <th v-for="(column, i) in columns" :key="i" scope="col" class="py-1 text-right font-normal break-all">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" :data-testid="`${testid}-row`">
            <th scope="row" class="py-1 text-left font-normal">{{ row.label }}</th>
            <td v-for="(cell, i) in row.cells" :key="i" class="py-1 text-right tabular-nums">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>
