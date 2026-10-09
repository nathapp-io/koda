<template>
  <div v-if="rows.length === 0" data-testid="fleet-schedule-history-empty">
    <EmptyState :message="t('fleet.schedules.history.empty')" />
  </div>
  <div v-else class="overflow-x-auto">
    <Table data-testid="fleet-schedule-history">
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.schedules.history.job') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.state') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.stories') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.cost') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.coalesced') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.push') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.reason') }}</TableHead>
          <TableHead>{{ t('fleet.schedules.history.queued') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow v-for="row in rows" :key="row.job.id" :data-testid="`fleet-schedule-run-${row.job.id}`">
          <TableCell>
            <NuxtLink :to="`/${slug}/fleet/jobs/${row.job.id}`" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ row.job.id.slice(0, 8) }}</NuxtLink>
          </TableCell>
          <TableCell><FleetJobStateBadge :state="row.job.state" /></TableCell>
          <TableCell data-testid="fleet-schedule-run-stories">{{ storiesText(row) }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-cost">{{ row.cost }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-coalesced">{{ row.job.coalescedCount }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-push" class="text-xs">{{ pushText(row) }}</TableCell>
          <TableCell data-testid="fleet-schedule-run-reason" class="max-w-[16rem] break-words text-xs" :title="row.job.stateReason ?? ''">{{ reasonText(row) }}</TableCell>
          <TableCell class="whitespace-nowrap text-xs">{{ formatInZone(row.job.queuedAt, timezone) }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { formatDelta, formatInZone } from '~/lib/fleet-schedules'
import type { HistoryRow } from '~/lib/fleet-schedules'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

defineProps<{ slug: string; rows: HistoryRow[]; timezone: string }>()

const { t } = useI18n()

/** D221: passed/total with the delta to the previous run; "-" without progress. */
function storiesText(row: HistoryRow): string {
  if (row.passed === null || row.total === null) return '-'
  return t('fleet.schedules.history.storiesValue', { passed: row.passed, total: row.total, delta: formatDelta(row.delta) })
}

function pushText(row: HistoryRow): string {
  if (row.wipPush === null) return '-'
  return row.wipPush.key === 'failed'
    ? t('fleet.jobs.detail.wipPush.failed', { reason: row.wipPush.reason })
    : t(`fleet.jobs.detail.wipPush.${row.wipPush.key}`)
}

/** A budget stop reads as one (D188); any other reason is shown as stored. */
function reasonText(row: HistoryRow): string {
  if (row.budgetPolicyId !== null) return t('fleet.schedules.history.budgetStop')
  return row.job.stateReason ?? '-'
}
</script>
