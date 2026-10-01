<script setup lang="ts">
import { computed } from 'vue'
import { extractProgress, formatUsd } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t } = useI18n()

const progress = computed(() => extractProgress(props.job.progress))
const percent = computed(() => (progress.value ? Math.round((progress.value.passed / progress.value.total) * 100) : 0))
</script>

<template>
  <dl class="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.progress') }}</dt>
      <dd data-testid="fleet-job-progress">
        <template v-if="progress">
          {{ t('fleet.jobs.detail.progressValue', { passed: progress.passed, total: progress.total, failed: progress.failed }) }}
          <div class="mt-1 h-1.5 w-full rounded bg-muted">
            <div class="h-1.5 rounded bg-primary" :style="{ width: `${percent}%` }" />
          </div>
        </template>
        <template v-else>-</template>
      </dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.story') }}</dt>
      <dd data-testid="fleet-job-story">{{ job.currentStoryId ?? '-' }}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.phase') }}</dt>
      <dd data-testid="fleet-job-phase">{{ job.currentPhase ?? '-' }}</dd>
    </div>
    <div>
      <dt class="text-muted-foreground">{{ t('fleet.jobs.detail.cost') }}</dt>
      <dd data-testid="fleet-job-cost">{{ t('fleet.jobs.detail.costOf', { spent: formatUsd(job.costSpentUsd), max: formatUsd(job.maxCostUsd) }) }}</dd>
    </div>
  </dl>
</template>
