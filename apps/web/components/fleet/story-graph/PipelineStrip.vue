<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import type { PipelineStage } from '~/lib/fleet-story-graph'

defineProps<{ stages: readonly PipelineStage[] }>()
const { t } = useI18n()

/** D429: a value nax may add later is shown as nax wrote it. */
const stateLabel = (stage: PipelineStage): string =>
  stage.known ? t(`fleet.jobs.detail.pipeline.state.${stage.state}`) : stage.state
</script>

<template>
  <ol class="flex flex-wrap items-center gap-2 text-sm" data-testid="fleet-pipeline-strip" :aria-label="t('fleet.jobs.detail.pipeline.title')">
    <li
      v-for="(stage, index) in stages"
      :key="stage.key"
      class="flex items-center gap-2"
      data-testid="fleet-pipeline-stage"
      :data-stage="stage.key"
      :data-state="stage.state"
    >
      <ChevronRight v-if="index > 0" class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <span>{{ t(`fleet.jobs.detail.pipeline.stage.${stage.key}`) }}</span>
      <Badge :variant="stage.variant">{{ stateLabel(stage) }}</Badge>
    </li>
  </ol>
</template>
