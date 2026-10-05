<script setup lang="ts">
import { computed } from 'vue'
import { SECTION_IDS, dashboardTiles } from '~/lib/fleet-dashboard'
import type { FleetDashboard, ScopeKind } from '~/lib/fleet-dashboard-types'

/**
 * Fleet S2b (c) spec §4 (B1, D422): one layout for both scopes. Loading, the first-load error, the stale note and
 * the four sections; the page owns the data (useFleetDashboard) and the 403 text.
 */
const props = defineProps<{
  snapshot: FleetDashboard | null
  failed: boolean
  staleSince: string | null
  now: Date
  scope: ScopeKind
  analyticsTo: string
}>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()

const tiles = computed(() => (props.snapshot ? dashboardTiles(props.snapshot.counts) : []))
</script>

<template>
  <div class="space-y-6" data-testid="fleet-dashboard">
    <div v-if="snapshot === null && failed" data-testid="fleet-dashboard-error">
      <ErrorState @retry="emit('retry')" />
    </div>
    <LoadingState v-else-if="snapshot === null" />
    <template v-else>
      <p class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="fleet-dashboard-updated">{{ t('fleet.dashboard.updated') }} <FleetAge :iso="snapshot.generatedAt" :now="now" mode="ago" /></span>
        <span v-if="staleSince" role="status" class="text-status-review" data-testid="fleet-dashboard-stale">
          {{ t('fleet.dashboard.staleSince', { time: staleSince }) }}
        </span>
      </p>

      <FleetDashboardTiles :tiles="tiles" />

      <section :id="SECTION_IDS.attention" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-attention">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.attention') }}</h2>
        <FleetDashboardAttentionList :items="snapshot.attention" :generated-at="snapshot.generatedAt" :now="now" :scope="scope" />
      </section>

      <section :id="SECTION_IDS.active" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-active">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.active') }}</h2>
        <FleetDashboardActiveRunsTable :jobs="snapshot.activeJobs" :now="now" :scope="scope" :truncated="snapshot.activeTruncated" />
      </section>

      <section :id="SECTION_IDS.runners" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-runners">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.runners') }}</h2>
        <FleetDashboardRunnerHealthList :runners="snapshot.runners" :now="now" :scope="scope" />
      </section>

      <section :id="SECTION_IDS.recent" class="scroll-mt-20 space-y-3" data-testid="fleet-dashboard-section-recent">
        <h2 class="text-sm font-semibold">{{ t('fleet.dashboard.sections.recent') }}</h2>
        <FleetDashboardRecentRunsList
          :jobs="snapshot.recentJobs"
          :now="now"
          :scope="scope"
          :truncated="snapshot.recentTruncated"
          :analytics-to="analyticsTo"
        />
      </section>
    </template>
  </div>
</template>
