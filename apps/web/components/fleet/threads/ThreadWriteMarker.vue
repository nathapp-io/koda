<script setup lang="ts">
import { computed } from 'vue'
import { writeMarkerView } from '~/lib/thread-timeline'
import type { ThreadWriteResult } from '~/lib/thread-types'

/**
 * Fleet S5a US-004: the thread's latest Publish or Discard result, in the transcript.
 *
 * Runner-written paths, reasons and ignored paths are `{{ }}` interpolation only, never v-html.
 */
const props = defineProps<{ write: ThreadWriteResult }>()
const { t } = useI18n()

const view = computed(() => writeMarkerView(props.write))
</script>

<template>
  <div class="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" data-testid="thread-write-marker">
    <div>{{ t(view.key, view.params) }}</div>
    <details v-if="view.paths.length > 0" class="mt-1">
      <summary class="cursor-pointer">{{ t('fleet.threads.handoff.markerPaths') }}</summary>
      <ul class="mt-1 space-y-0.5 font-mono">
        <li v-for="path in view.paths" :key="path" data-testid="thread-write-marker-path">{{ path }}</li>
      </ul>
    </details>
    <div v-if="view.ignored.length > 0" class="mt-1">
      <div>{{ t('fleet.threads.handoff.markerIgnored') }}</div>
      <ul class="mt-0.5 space-y-0.5 font-mono" data-testid="thread-write-marker-ignored">
        <li v-for="path in view.ignored" :key="path">{{ path }}</li>
      </ul>
    </div>
  </div>
</template>
