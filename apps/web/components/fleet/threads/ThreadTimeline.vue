<script setup lang="ts">
import { computed } from 'vue'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
import { buildThreadTimeline } from '~/lib/thread-timeline'

/**
 * Fleet S5a §4.62 (US-006, US-004): the transcript — the pending-question card, the context-reset
 * marker, then the messages with the thread's latest write marker and PLAN/RUN cards placed among
 * them by their timestamps (`buildThreadTimeline`).
 */
const props = withDefaults(defineProps<{
  thread: ThreadDetailDto
  messages: ChatMessageDto[]
  isCreator: boolean
  /** The loaded PLAN and RUN job details; a detail for another job is ignored by the builder. */
  jobs?: { plan: FleetJobDto | null; run: FleetJobDto | null }
  /** The project slug, for the links on the job cards. */
  slug?: string
}>(), {
  jobs: () => ({ plan: null, run: null }),
  slug: '',
})
const emit = defineEmits<{
  (event: 'answer', requestId: string, text: string): void
}>()
const { t } = useI18n()

const entries = computed(() => buildThreadTimeline(props.messages, props.thread, props.jobs))

function onAnswer(requestId: string, text: string): void {
  emit('answer', requestId, text)
}
</script>

<template>
  <div class="space-y-3" data-testid="thread-timeline">
    <FleetThreadsThreadQuestionCard
      v-if="props.thread.pendingQuestion"
      :question="props.thread.pendingQuestion"
      :is-creator="props.isCreator"
      @answer="onAnswer"
    />
    <div v-if="props.thread.session && props.thread.session.contextReset" class="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" data-testid="thread-context-reset">
      {{ t('fleet.threads.detail.contextReset') }}
    </div>
    <template v-for="entry in entries" :key="entry.key">
      <FleetThreadsThreadMessage v-if="entry.kind === 'message'" :message="entry.message" />
      <FleetThreadsThreadWriteMarker v-else-if="entry.kind === 'write'" :write="entry.write" />
      <FleetThreadsThreadJobCard
        v-else
        :command="entry.command"
        :handoff="entry.handoff"
        :job="entry.job"
        :slug="props.slug"
      />
    </template>
  </div>
</template>
