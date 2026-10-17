<script setup lang="ts">
import { computed } from 'vue'
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'
import { buildThreadTimeline } from '~/lib/thread-timeline'

/**
 * Fleet S5a §4.62 (US-006, US-004): the transcript — the pending-question card, the context-reset
 * marker, then the messages with the thread's latest write marker and PLAN/RUN cards placed among
 * them by their timestamps (`buildThreadTimeline`).
 *
 * Fleet S5b §2aw-D11 (US-005): the thread's pending assistant actions render as cards between the
 * question card and the entries, decided by the creator alone (2a-R2). A payload written before the
 * feature has no `pendingActions` and renders none.
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
/** D292: the action cards count their expiry down on the thread's own clock. */
const { now } = useApprovalCountdown()
const pendingActions = computed(() => props.thread.pendingActions ?? [])

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
    <FleetThreadsThreadActionCard
      v-for="action in pendingActions"
      :key="action.id"
      :action="action"
      :can-decide="props.isCreator"
      :now="now"
    />
    <div v-if="props.thread.session && props.thread.session.contextReset" class="rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" data-testid="thread-context-reset">
      {{ t('fleet.threads.detail.contextReset') }}
    </div>
    <template v-for="entry in entries" :key="entry.key">
      <FleetThreadsThreadMessage v-if="entry.kind === 'message'" :message="entry.message" :slug="props.slug" />
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
