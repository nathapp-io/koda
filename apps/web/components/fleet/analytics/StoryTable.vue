<script setup lang="ts">
import { timeText, usd } from '~/lib/fleet-analytics-format'
import type { StoryAnalyticsRowDto } from '~/lib/fleet-analytics-types'

/** Spec §5.2: most expensive / most-looping stories; each row opens its job. */
defineProps<{ slug: string; rows: readonly StoryAnalyticsRowDto[]; testid: string }>()
const { t } = useI18n()
</script>

<template>
  <div class="overflow-x-auto">
    <table class="w-full text-sm" :data-testid="testid">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.story') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.feature') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.attempts') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.firstPass') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.table.cost') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.table.completed') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="`${row.jobId}:${row.leaseEpoch}:${row.storyId}`" :data-testid="`${testid}-row`">
          <td class="py-1">
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.jobId}`" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ row.storyId }}</NuxtLink>
          </td>
          <td class="py-1 break-all">{{ row.featureName }}</td>
          <td class="py-1 text-right tabular-nums">{{ row.attempts }}</td>
          <td class="py-1">{{ row.firstPassSuccess ? t('fleet.analytics.table.yes') : t('fleet.analytics.table.no') }}</td>
          <td class="py-1 text-right tabular-nums">{{ usd(row.costUsd) }}</td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.completedAt) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
