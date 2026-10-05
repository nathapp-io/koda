<script setup lang="ts">
import type { ChartSeries } from '~/lib/fleet-analytics-chart'
import { tokenText, usd } from '~/lib/fleet-analytics-format'

/** The legend is also the totals table for the spend chart (identity never by color alone). */
defineProps<{ series: readonly ChartSeries[]; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.legend.group') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.legend.cost') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.legend.tokens') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="s in series"
          :key="`${s.folded ? 'fold' : 'key'}:${s.key}`"
          :data-testid="`${testid}-row`"
          :data-key="s.key"
          :data-folded="s.folded ? 'true' : 'false'"
        >
          <td class="py-1 break-all">
            <span class="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" :style="{ backgroundColor: s.color }" aria-hidden="true" />{{ s.label }}
          </td>
          <td class="py-1 text-right tabular-nums">{{ usd(s.costUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ tokenText(s.tokens) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
