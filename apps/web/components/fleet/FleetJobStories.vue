<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import { phaseLabelKey } from '~/lib/fleet-phase'
import type { StoryRow } from '~/lib/fleet-jobs'

/** D443: the List view of FleetJobPipeline; the heading and truncation note live there. */
defineProps<{ rows: readonly StoryRow[] }>()
const { t, te } = useI18n()

const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.storyStatus', status)
/** D7: a known nax phase reads as its label; any other nax text is shown raw (R4). */
const phaseText = (phase: string): string => {
  const key = phaseLabelKey(phase)
  return key === null ? phase : t(key)
}
</script>

<template>
  <ul class="divide-y divide-border rounded-md border border-border text-sm" data-testid="fleet-job-stories">
    <li
      v-for="row in rows"
      :key="row.id"
      class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
      :class="row.current ? 'bg-muted' : ''"
      data-testid="fleet-job-story"
      :data-story="row.id"
      :data-current="row.current ? 'true' : 'false'"
      :aria-current="row.current ? 'step' : undefined"
    >
      <span class="font-mono text-xs">{{ row.id }}</span>
      <span class="min-w-0 flex-1 break-words">{{ row.title }}</span>
      <span v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-job-story-phase">{{ t('fleet.jobs.detail.stories.phase', { phase: phaseText(row.phase) }) }}</span>
      <span class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</span>
      <Badge :variant="row.variant">{{ statusLabel(row.status) }}</Badge>
      <span v-if="row.dependsOn.length > 0" class="basis-full text-xs text-muted-foreground" data-testid="fleet-job-story-deps">
        {{ t('fleet.jobs.detail.pipeline.dependsOn', { ids: row.dependsOn.join(', ') }) }}
      </span>
    </li>
  </ul>
</template>
