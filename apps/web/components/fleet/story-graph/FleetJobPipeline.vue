<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import FleetJobStories from '~/components/fleet/FleetJobStories.vue'
import PipelineStrip from '~/components/fleet/story-graph/PipelineStrip.vue'
import StoryGraph from '~/components/fleet/story-graph/StoryGraph.vue'
import { storyRows } from '~/lib/fleet-jobs'
import { layoutStoryGraph, pipelineStages } from '~/lib/fleet-story-graph'
import { initialStoryView, readStoryView, wideViewport, writeStoryView } from '~/lib/fleet-story-view'
import type { StoryView } from '~/lib/fleet-story-view'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t } = useI18n()

const rows = computed(() => storyRows(props.job))
const layout = computed(() => layoutStoryGraph(rows.value))
const stages = computed(() => pipelineStages(props.job))
/** D441: null until mounted; meanwhile CSS shows Graph at md+ and List below, so SSR and hydration agree. */
const view = ref<StoryView | null>(null)

onMounted(() => {
  view.value = initialStoryView(readStoryView(), wideViewport())
})

function choose(next: StoryView): void {
  view.value = next
  writeStoryView(next)
}
</script>

<template>
  <section v-if="rows.length > 0" class="space-y-3" data-testid="fleet-job-pipeline">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-medium">{{ t('fleet.jobs.detail.stories.title') }}</h2>
      <div class="flex gap-1" role="group" :aria-label="t('fleet.jobs.detail.pipeline.view.label')" data-testid="fleet-story-view-toggle">
        <Button
          size="sm"
          :variant="view === 'graph' ? 'default' : 'outline'"
          :aria-pressed="view === 'graph'"
          data-testid="fleet-story-view-graph"
          @click="choose('graph')"
        >
          {{ t('fleet.jobs.detail.pipeline.view.graph') }}
        </Button>
        <Button
          size="sm"
          :variant="view === 'list' ? 'default' : 'outline'"
          :aria-pressed="view === 'list'"
          data-testid="fleet-story-view-list"
          @click="choose('list')"
        >
          {{ t('fleet.jobs.detail.pipeline.view.list') }}
        </Button>
      </div>
    </div>
    <PipelineStrip v-if="stages.length > 0" :stages="stages" />
    <StoryGraph v-if="view !== 'list'" :layout="layout" :class="view === null ? 'hidden md:block' : ''" />
    <FleetJobStories v-if="view !== 'graph'" :rows="rows" :class="view === null ? 'md:hidden' : ''" />
    <p v-if="job.storiesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-job-stories-truncated">
      {{ t('fleet.jobs.detail.stories.truncated', { count: rows.length }) }}
    </p>
  </section>
</template>
