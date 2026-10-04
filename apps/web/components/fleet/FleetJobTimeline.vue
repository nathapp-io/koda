<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import { summarizeEvent, visibleTimelineEvents, type TimelineEntry } from '~/lib/fleet-jobs'
import type { FleetJobEventDto } from '~/lib/fleet-types'

const props = withDefaults(defineProps<{
  events: FleetJobEventDto[]
  hasMore: boolean
  loading: boolean
  /** S2a §4.2: attempts with stored log streams, latest first; each gets a "Full log" row. */
  logAttempts?: readonly number[]
  logsHref?: string
}>(), { logAttempts: () => [], logsHref: '' })
const emit = defineEmits<{ loadMore: [] }>()
const { t, te } = useI18n()

const stateLabel = (code: string): string => codeLabel(t, te, 'fleet.state', code)

function describe(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'transition':
      // Only server rows reach here (visibleTimelineEvents); the one without `from` is the dispatch.
      return entry.from
        ? t('fleet.jobs.timeline.transition', { from: stateLabel(entry.from), to: stateLabel(entry.to) })
        : t('fleet.jobs.timeline.queued')
    case 'snapshot':
      return entry.parts.length > 0
        ? t('fleet.jobs.timeline.snapshot', { detail: entry.parts.join(' | ') })
        : t('fleet.jobs.timeline.snapshotEmpty')
    case 'lifecycle':
      return t('fleet.jobs.timeline.lifecycle', { level: entry.level, message: entry.message })
    case 'log':
      return t('fleet.jobs.timeline.log', { text: entry.text })
    case 'approval':
      return t('fleet.jobs.timeline.approval', { command: entry.command })
    default:
      return t('fleet.jobs.timeline.unknown', { type: entry.type })
  }
}

const rows = computed(() => visibleTimelineEvents(props.events).map((event) => {
  const entry = summarizeEvent(event)
  return {
    id: event.id,
    seq: event.seq,
    at: new Date(event.createdAt).toLocaleString(),
    text: describe(entry),
    reason: entry.kind === 'transition' ? entry.reason : null,
  }
}))
</script>

<template>
  <section id="timeline" class="space-y-3" data-testid="fleet-job-timeline">
    <h2 class="text-lg font-semibold">{{ t('fleet.jobs.timeline.title') }}</h2>
    <ul v-if="logsHref && logAttempts.length > 0" class="space-y-1 text-sm">
      <li v-for="epoch in logAttempts" :key="epoch">
        <NuxtLink :to="{ path: logsHref, query: { epoch: String(epoch) } }" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-job-timeline-logs">
          {{ t('fleet.jobs.timeline.logs', { epoch }) }} &rarr;
        </NuxtLink>
      </li>
    </ul>
    <p v-if="rows.length === 0 && !loading" class="text-sm text-muted-foreground">{{ t('fleet.jobs.timeline.empty') }}</p>
    <ol class="space-y-2">
      <li v-for="row in rows" :key="row.id" class="flex gap-3 text-sm" data-testid="fleet-job-event">
        <span class="w-10 shrink-0 text-right text-muted-foreground">{{ row.seq }}</span>
        <span class="w-44 shrink-0 text-muted-foreground">{{ row.at }}</span>
        <span class="break-all">
          {{ row.text }}
          <span v-if="row.reason" class="text-muted-foreground"> - {{ row.reason }}</span>
        </span>
      </li>
    </ol>
    <Button v-if="hasMore" variant="outline" size="sm" :disabled="loading" data-testid="fleet-job-events-more" @click="emit('loadMore')">
      {{ t('fleet.jobs.timeline.loadMore') }}
    </Button>
  </section>
</template>
