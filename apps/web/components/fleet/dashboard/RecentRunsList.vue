<script setup lang="ts">
import { computed } from 'vue'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import { usd } from '~/lib/fleet-analytics-format'
import { durationParts, jobPath, safeHttpUrl } from '~/lib/fleet-dashboard'
import type { DashboardRecentJob, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2, B6: jobs finished in the last 24 h (newest first, at most 20), with a link to the Analytics page. */
const props = defineProps<{ jobs: readonly DashboardRecentJob[]; now: Date; scope: ScopeKind; truncated: boolean; analyticsTo: string }>()
const { t } = useI18n()

const rows = computed(() =>
  props.jobs.map((job) => {
    const duration = durationParts(job.startedAt, job.finishedAt)
    return {
      job,
      duration: duration ? t(`fleet.common.duration.${duration.unit}`, { n: duration.n }) : '-',
      prUrl: safeHttpUrl(job.resultPrUrl),
    }
  }))
</script>

<template>
  <div class="space-y-2">
    <EmptyState v-if="jobs.length === 0" :message="t('fleet.dashboard.recent.empty')" />
    <div v-else class="overflow-x-auto">
      <Table data-testid="fleet-dashboard-recent">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.dashboard.recent.columns.feature') }}</TableHead>
            <TableHead v-if="scope === 'global'">{{ t('fleet.dashboard.recent.columns.project') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.state') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.runner') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.duration') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.cost') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.recent.columns.finished') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in rows" :key="row.job.id" data-testid="fleet-dashboard-recent-row" :data-job="row.job.id">
            <TableCell>
              <NuxtLink
                :to="jobPath(row.job.projectSlug, row.job.id)"
                class="break-all font-medium text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-recent-link"
              >{{ row.job.feature }}</NuxtLink>
            </TableCell>
            <TableCell v-if="scope === 'global'">{{ row.job.projectSlug }}</TableCell>
            <TableCell>
              <FleetJobStateBadge :state="row.job.state" />
              <div v-if="row.job.stateReason" class="mt-1 text-xs text-muted-foreground" data-testid="fleet-dashboard-recent-reason">
                {{ row.job.stateReason }}
              </div>
            </TableCell>
            <TableCell>{{ row.job.runnerName ?? '-' }}</TableCell>
            <TableCell data-testid="fleet-dashboard-recent-duration">{{ row.duration }}</TableCell>
            <TableCell class="whitespace-nowrap" data-testid="fleet-dashboard-recent-cost">{{ usd(row.job.costSpentUsd) }}</TableCell>
            <TableCell class="whitespace-nowrap"><FleetAge :iso="row.job.finishedAt" :now="now" mode="ago" /></TableCell>
            <TableCell>
              <a
                v-if="row.prUrl"
                :href="row.prUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-recent-pr"
              >{{ t('fleet.dashboard.recent.pr') }}</a>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p v-if="truncated" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-recent-truncated">
      {{ t('fleet.dashboard.recent.truncated') }}
    </p>
    <NuxtLink :to="analyticsTo" class="inline-block text-sm text-primary underline-offset-4 hover:underline" data-testid="fleet-dashboard-analytics-link">
      {{ t('fleet.dashboard.recent.analyticsLink') }}
    </NuxtLink>
  </div>
</template>
