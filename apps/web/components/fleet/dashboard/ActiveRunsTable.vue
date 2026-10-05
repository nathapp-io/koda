<script setup lang="ts">
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import { costText, jobPath, storiesText } from '~/lib/fleet-dashboard'
import type { DashboardActiveJob, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2: what is queued or running now, oldest first; the feature opens the job page. */
defineProps<{ jobs: readonly DashboardActiveJob[]; now: Date; scope: ScopeKind; truncated: boolean }>()
const { t } = useI18n()

/** A queued job has no runner yet; a held job whose runner was deleted has an id but no name. */
function runnerText(job: DashboardActiveJob): string {
  if (job.runnerName) return job.runnerName
  return job.runnerId === null ? t('fleet.dashboard.active.unassigned') : t('fleet.common.unknown')
}
</script>

<template>
  <EmptyState v-if="jobs.length === 0" :message="t('fleet.dashboard.active.empty')" />
  <div v-else class="space-y-2">
    <div class="overflow-x-auto">
      <Table data-testid="fleet-dashboard-active">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.dashboard.active.columns.feature') }}</TableHead>
            <TableHead v-if="scope === 'global'">{{ t('fleet.dashboard.active.columns.project') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.repo') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.state') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.runner') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.story') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.phase') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.stories') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.cost') }}</TableHead>
            <TableHead>{{ t('fleet.dashboard.active.columns.heartbeat') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="job in jobs" :key="job.id" data-testid="fleet-dashboard-active-row" :data-job="job.id">
            <TableCell>
              <NuxtLink
                :to="jobPath(job.projectSlug, job.id)"
                class="break-all font-medium text-primary underline-offset-4 hover:underline"
                data-testid="fleet-dashboard-active-link"
              >{{ job.feature }}</NuxtLink>
              <Badge v-if="job.pendingApprovals > 0" variant="destructive" class="ml-2" data-testid="fleet-dashboard-active-approvals">
                {{ t('fleet.dashboard.active.approvals', { n: job.pendingApprovals }) }}
              </Badge>
            </TableCell>
            <TableCell v-if="scope === 'global'">{{ job.projectSlug }}</TableCell>
            <TableCell class="text-muted-foreground">{{ job.repo }}</TableCell>
            <TableCell><FleetJobStateBadge :state="job.state" /></TableCell>
            <TableCell data-testid="fleet-dashboard-active-runner">{{ runnerText(job) }}</TableCell>
            <TableCell>{{ job.currentStoryId ?? '-' }}</TableCell>
            <TableCell>{{ job.currentPhase ?? '-' }}</TableCell>
            <TableCell data-testid="fleet-dashboard-active-stories">{{ storiesText(job.storiesDone, job.storiesTotal) }}</TableCell>
            <TableCell class="whitespace-nowrap" data-testid="fleet-dashboard-active-cost">{{ costText(job.costSpentUsd, job.maxCostUsd) }}</TableCell>
            <TableCell class="whitespace-nowrap"><FleetAge :iso="job.lastHeartbeatAt" :now="now" mode="ago" /></TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <p v-if="truncated" class="text-xs text-muted-foreground" data-testid="fleet-dashboard-active-truncated">
      {{ t('fleet.dashboard.active.truncated') }}
    </p>
  </div>
</template>
