<script setup lang="ts">
import type { ChatMessageDto, ThreadDetailDto } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-006): the transcript — the pending-question card, the context-reset marker
 * and one ThreadMessage per held message, newest last.
 */
const props = defineProps<{
  thread: ThreadDetailDto
  messages: ChatMessageDto[]
  isCreator: boolean
}>()
const emit = defineEmits<{
  (event: 'answer', requestId: string, text: string): void
}>()
const { t } = useI18n()

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
    <FleetThreadsThreadMessage v-for="message in props.messages" :key="message.id" :message="message" />
  </div>
</template>