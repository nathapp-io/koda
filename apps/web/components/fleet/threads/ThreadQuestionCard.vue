<script setup lang="ts">
import { ref } from 'vue'
import type { ThreadPendingQuestion } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-007): the pending-question card. The question text is runner/agent
 * text: `{{ }}` interpolation only (B4-D1). The creator sees an answer field and a Send
 * control that emit `answer(requestId, text)`; a non-creator sees the question text with
 * no answer input.
 */
const props = defineProps<{ question: ThreadPendingQuestion; isCreator: boolean }>()
const emit = defineEmits<{
  (event: 'answer', requestId: string, text: string): void
}>()
const { t } = useI18n()

const answer = ref('')

function onInput(event: Event): void {
  answer.value = (event.target as HTMLInputElement).value
}

function sendAnswer(): void {
  const text = answer.value.trim()
  if (text.length === 0) return
  emit('answer', props.question.requestId, text)
}
</script>

<template>
  <div class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-question" role="status">
    <p class="whitespace-pre-wrap break-words">{{ props.question.text }}</p>
    <div v-if="props.isCreator" class="mt-2 flex items-center gap-2">
      <Input
        :model-value="answer"
        :placeholder="t('fleet.threads.question.placeholder')"
        data-testid="thread-answer-input"
        @input="onInput"
      />
      <Button type="button" size="sm" data-testid="thread-answer-send" @click="sendAnswer">{{ t('fleet.threads.question.send') }}</Button>
    </div>
  </div>
</template>