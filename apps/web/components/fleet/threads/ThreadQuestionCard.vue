<script setup lang="ts">
import { useField } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { buildThreadMessageSchema } from '~/lib/thread-create'
import type { ThreadPendingQuestion } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-007): the pending-question card. The question text is runner/agent
 * text: `{{ }}` interpolation only (B4-D1). The creator sees an answer field and a Send
 * control that emit `answer(requestId, text)`; a non-creator sees the question text with
 * no answer input.
 *
 * US-007: the answer validates with vee-validate + a zod schema (`buildThreadMessageSchema`:
 * trimmed, non-empty, at most 32768 UTF-8 bytes — the API's limit), the same rule the
 * composer applies.
 */
const props = defineProps<{ question: ThreadPendingQuestion; isCreator: boolean }>()
const emit = defineEmits<{
  (event: 'answer', requestId: string, text: string): void
}>()
const { t } = useI18n()

const { value: answer, errorMessage, validate } = useField(
  'answer',
  toTypedSchema(buildThreadMessageSchema(t)),
  { initialValue: '' },
)

/** Sends the trimmed answer when it passes the schema (non-empty, ≤32768 UTF-8 bytes). */
async function sendAnswer(): Promise<void> {
  const { valid } = await validate()
  if (!valid) return
  emit('answer', props.question.requestId, String(answer.value ?? '').trim())
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
        @update:model-value="answer = $event"
      />
      <Button type="button" size="sm" data-testid="thread-answer-send" @click="sendAnswer">{{ t('fleet.threads.question.send') }}</Button>
    </div>
    <p v-if="props.isCreator && errorMessage" class="mt-1 text-xs text-destructive" role="alert">{{ errorMessage }}</p>
  </div>
</template>
