<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useFleetDashboard } from '~/composables/useFleetDashboard'

definePageMeta({ layout: 'default' })

/** Fleet S2b (c) spec §4.1 (B1, B5): this project's jobs and the health of every runner (project members). */
const route = useRoute()
const { t } = useI18n()
const slug = route.params.project as string
const { data, forbidden, failed, staleSince, now, refresh, start, stop } = useFleetDashboard({ kind: 'project', slug })

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.dashboard.title')" :subtitle="t('fleet.dashboard.projectSubtitle')" />
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-dashboard-forbidden">{{ t('fleet.dashboard.forbidden') }}</p>
    <FleetDashboardOverview
      v-else
      :snapshot="data"
      :failed="failed"
      :stale-since="staleSince"
      :now="now"
      scope="project"
      :analytics-to="`/${slug}/fleet/analytics`"
      @retry="refresh()"
    />
  </div>
</template>
