<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useFleetDashboard } from '~/composables/useFleetDashboard'

definePageMeta({ layout: 'default' })

/** Fleet S2b (c) spec §4.1: every runner and the active jobs of every project (global admin; others see the 403 note). */
const { t } = useI18n()
const { data, forbidden, failed, staleSince, now, refresh, start, stop } = useFleetDashboard({ kind: 'global' })

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.dashboard.title')" :subtitle="t('fleet.dashboard.adminSubtitle')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-forbidden">{{ t('fleet.common.adminOnly') }}</p>
    <FleetDashboardOverview
      v-else
      :snapshot="data"
      :failed="failed"
      :stale-since="staleSince"
      :now="now"
      scope="global"
      analytics-to="/admin/fleet/analytics"
      @retry="refresh()"
    />
  </div>
</template>
