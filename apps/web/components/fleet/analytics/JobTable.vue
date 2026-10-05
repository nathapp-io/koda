<script setup lang="ts">
import { timeText, usd } from '~/lib/fleet-analytics-format'
import type { JobAnalyticsRowDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/** Spec §5.2, D382: most expensive jobs with the ledger and drift (null before ingest). */
defineProps<{ slug: string; rows: readonly JobAnalyticsRowDto[]; testid: string }>()
const { t, te } = useI18n()
const stateLabel = (state: string): string => codeLabel(t, te, 'fleet.state', state)
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.job') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.command') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.state') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.ledger') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.drift') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.finished') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.jobId" :data-testid="`${testid}-row`" :data-job="row.jobId">
          <td class="py-1 break-all">
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.jobId}`" class="text-primary underline-offset-4 hover:underline">{{ row.featureName }}</NuxtLink>
          </td>
          <td class="py-1">{{ row.command }}</td>
          <td class="py-1">{{ stateLabel(row.state) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.costUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.ledgerCostUsd) }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.driftUsd) }}</td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.finishedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
