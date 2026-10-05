<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import StoryNode from '~/components/fleet/story-graph/StoryNode.vue'
import { edgePaths, neighbourhood } from '~/lib/fleet-story-graph'
import type { Box, EdgePath, StoryGraphLayout } from '~/lib/fleet-story-graph'

const props = defineProps<{ layout: StoryGraphLayout }>()
const { t } = useI18n()

const wrapEl = ref<HTMLElement | null>(null)
const boxes = ref<Readonly<Record<string, Box>>>({})
const size = ref({ width: 0, height: 0 })
const activeId = ref<string | null>(null)

const paths = computed(() => edgePaths(props.layout.edges, boxes.value))
const near = computed(() => neighbourhood(props.layout.edges, activeId.value))

const notesFor = (id: string) => props.layout.unresolved.filter(note => note.story === id)
const nodeEmphasis = (id: string): 'normal' | 'active' | 'dim' => {
  const set = near.value
  if (set === null) return 'normal'
  return set.has(id) ? 'active' : 'dim'
}
const edgeActive = (edge: EdgePath): boolean =>
  activeId.value !== null && (edge.from === activeId.value || edge.to === activeId.value)
const edgeClass = (edge: EdgePath): string => {
  if (activeId.value === null) return 'stroke-border'
  return edgeActive(edge) ? 'stroke-primary' : 'stroke-border opacity-30'
}

/** D431: edges come from measured node boxes, so they exist only in a browser after mount. */
function measure(): void {
  const wrap = wrapEl.value
  if (!wrap || typeof wrap.getBoundingClientRect !== 'function') return
  const origin = wrap.getBoundingClientRect()
  const nodes = Array.from(wrap.querySelectorAll<HTMLElement>('[data-testid="fleet-story-node"]'))
  boxes.value = Object.fromEntries(nodes.flatMap((el) => {
    const id = el.dataset.story
    if (!id) return []
    const rect = el.getBoundingClientRect()
    return [[id, { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height }]]
  }))
  size.value = { width: wrap.scrollWidth, height: wrap.scrollHeight }
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (typeof ResizeObserver === 'undefined' || !wrapEl.value) return
  observer = new ResizeObserver(() => measure())
  observer.observe(wrapEl.value)
  measure()
})
// A live reload builds a new layout object; status lines can change node heights, so measure again.
watch(() => props.layout, () => { void nextTick(measure) })
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div class="overflow-x-auto pb-2" data-testid="fleet-story-graph" role="group" :aria-label="t('fleet.jobs.detail.pipeline.graphLabel')">
    <div ref="wrapEl" class="relative inline-flex min-w-full gap-12 p-1">
      <svg
        v-if="paths.length > 0"
        class="pointer-events-none absolute left-0 top-0"
        :width="size.width"
        :height="size.height"
        aria-hidden="true"
        focusable="false"
      >
        <path
          v-for="edge in paths"
          :key="`${edge.from}>${edge.to}`"
          :d="edge.d"
          fill="none"
          stroke-width="1.5"
          :class="edgeClass(edge)"
          data-testid="fleet-story-edge"
          :data-from="edge.from"
          :data-to="edge.to"
          :data-active="edgeActive(edge) ? 'true' : 'false'"
        />
      </svg>
      <ol
        v-for="(column, index) in layout.columns"
        :key="index"
        class="relative flex flex-col justify-center gap-4"
        :aria-label="t('fleet.jobs.detail.pipeline.column', { n: index + 1 })"
      >
        <StoryNode
          v-for="row in column"
          :key="row.id"
          :row="row"
          :column="index"
          :notes="notesFor(row.id)"
          :emphasis="nodeEmphasis(row.id)"
          @activate="activeId = $event"
        />
      </ol>
    </div>
  </div>
</template>
