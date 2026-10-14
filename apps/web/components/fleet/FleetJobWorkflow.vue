<script setup lang="ts">
import { computed } from 'vue'
import type { FleetJobWorkflowDto } from '~/lib/fleet-types'

const props = defineProps<{ workflow: FleetJobWorkflowDto }>()
const { t } = useI18n()

const outcomeText = computed(() => {
  if (props.workflow.outcome === 'draft') return t('fleet.jobs.workflow.outcome.draft')
  if (props.workflow.outcome === 'local-only') return t('fleet.jobs.workflow.outcome.localOnly')
  return t('fleet.jobs.workflow.outcome.ready')
})

const fileLabel = (file: string | null, line: number | null): string | null => {
  if (!file) return null
  return line === null || line === undefined ? file : `${file}:${line}`
}
</script>

<template>
  <section class="space-y-3 rounded-md border border-border p-4 text-sm" data-testid="fleet-job-workflow">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="text-sm font-medium">{{ t('fleet.jobs.workflow.title') }}</h2>
      <Badge data-testid="fleet-job-workflow-outcome">{{ outcomeText }}</Badge>
    </div>

    <div v-if="workflow.reasons.length > 0">
      <p class="text-muted-foreground">{{ t('fleet.jobs.workflow.reasons') }}</p>
      <ul class="mt-1 space-y-1" data-testid="fleet-job-workflow-reasons">
        <li v-for="(reason, index) in workflow.reasons" :key="index" class="break-words">{{ reason }}</li>
      </ul>
    </div>

    <div v-if="workflow.openItems.length > 0">
      <p class="text-muted-foreground">{{ t('fleet.jobs.workflow.openItems') }}</p>
      <ul class="mt-1 space-y-1" data-testid="fleet-job-workflow-open-items">
        <li
          v-for="openItem in workflow.openItems"
          :key="openItem.id"
          class="flex flex-wrap items-center gap-x-2 gap-y-1 break-words"
        >
          <span>{{ openItem.kind }}</span>
          <span v-if="openItem.severity" class="text-muted-foreground">{{ openItem.severity }}</span>
          <span v-if="fileLabel(openItem.file, openItem.line)" class="font-mono text-xs">{{ fileLabel(openItem.file, openItem.line) }}</span>
          <span>{{ openItem.issue }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>
