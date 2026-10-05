<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import type { StoryRow } from '~/lib/fleet-jobs'
import type { UnresolvedDep } from '~/lib/fleet-story-graph'

const props = defineProps<{
  row: StoryRow
  column: number
  notes: readonly UnresolvedDep[]
  emphasis: 'normal' | 'active' | 'dim'
}>()
const emit = defineEmits<{ activate: [id: string | null] }>()
const { t, te } = useI18n()

const statusLabel = computed(() => codeLabel(t, te, 'fleet.storyStatus', props.row.status))
/** D446: screen readers hear the status and every dependency, since edges are decorative. */
const label = computed(() => {
  const base = { id: props.row.id, title: props.row.title, status: statusLabel.value }
  return props.row.dependsOn.length > 0
    ? t('fleet.jobs.detail.pipeline.nodeLabel', { ...base, deps: props.row.dependsOn.join(', ') })
    : t('fleet.jobs.detail.pipeline.nodeLabelRoot', base)
})
const noteText = (note: UnresolvedDep): string =>
  t(note.reason === 'cycle' ? 'fleet.jobs.detail.pipeline.cycle' : 'fleet.jobs.detail.pipeline.notShown', { id: note.dep })
</script>

<template>
  <li
    tabindex="0"
    class="relative w-56 shrink-0 space-y-1 rounded-md border border-border bg-background p-2 text-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring"
    :class="[row.current ? 'ring-2 ring-primary' : '', emphasis === 'dim' ? 'opacity-40' : '']"
    data-testid="fleet-story-node"
    :data-story="row.id"
    :data-column="String(column)"
    :data-current="row.current ? 'true' : 'false'"
    :data-status="row.status"
    :data-emphasis="emphasis"
    :aria-current="row.current ? 'step' : undefined"
    :aria-label="label"
    @focus="emit('activate', row.id)"
    @blur="emit('activate', null)"
    @mouseenter="emit('activate', row.id)"
    @mouseleave="emit('activate', null)"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="font-mono text-xs">{{ row.id }}</span>
      <Badge :variant="row.variant">{{ statusLabel }}</Badge>
    </div>
    <p class="line-clamp-2 break-words" :title="row.title">{{ row.title }}</p>
    <p class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</p>
    <p v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-story-node-phase">
      {{ t('fleet.jobs.detail.stories.phase', { phase: row.phase }) }}
    </p>
    <p
      v-for="note in notes"
      :key="`${note.reason}:${note.dep}`"
      class="text-xs text-muted-foreground"
      data-testid="fleet-story-node-note"
      :data-reason="note.reason"
    >
      {{ noteText(note) }}
    </p>
  </li>
</template>
