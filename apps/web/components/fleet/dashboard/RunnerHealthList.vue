<script setup lang="ts">
import type { DashboardRunner, ScopeKind } from '~/lib/fleet-dashboard-types'

/** Spec §4.2, B5: every runner; versions and credentials only in the admin scope. */
defineProps<{ runners: readonly DashboardRunner[]; now: Date; scope: ScopeKind }>()
const { t } = useI18n()
</script>

<template>
  <EmptyState v-if="runners.length === 0" :message="t('fleet.dashboard.runners.empty')" />
  <ul v-else class="divide-y divide-border rounded-md border border-border" data-testid="fleet-dashboard-runners-list">
    <li
      v-for="runner in runners"
      :key="runner.id"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 p-3"
      data-testid="fleet-dashboard-runner"
      :data-runner="runner.id"
      :data-online="runner.online ? 'true' : 'false'"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="runner.online ? 'bg-status-done' : 'bg-status-todo'" aria-hidden="true" />
        <span class="break-all font-medium">{{ runner.name }}</span>
        <span class="text-xs text-muted-foreground">{{ runner.os }}/{{ runner.arch }}</span>
      </div>
      <Badge :variant="runner.online ? 'secondary' : 'outline'">
        {{ runner.online ? t('fleet.common.online') : t('fleet.common.offline') }}
      </Badge>
      <Badge v-if="!runner.enabled" variant="destructive">{{ t('fleet.common.disabled') }}</Badge>
      <span class="text-sm" data-testid="fleet-dashboard-runner-busy">
        {{ t('fleet.dashboard.runners.busy', { active: runner.activeJobs, capacity: runner.capacity }) }}
      </span>
      <span class="text-xs text-muted-foreground">
        {{ t('fleet.dashboard.runners.lastSeen') }} <FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" />
      </span>
      <template v-if="scope === 'global'">
        <span class="text-xs text-muted-foreground" data-testid="fleet-dashboard-runner-versions">
          {{ runner.naxVersion ? t('fleet.dashboard.runners.nax', { version: runner.naxVersion }) : t('fleet.dashboard.runners.naxUnknown') }}<template v-if="runner.daemonVersion"> · {{ t('fleet.dashboard.runners.daemon', { version: runner.daemonVersion }) }}</template>
        </span>
        <FleetDashboardCredentialDigestChips :credentials="runner.credentials" />
      </template>
    </li>
  </ul>
</template>
