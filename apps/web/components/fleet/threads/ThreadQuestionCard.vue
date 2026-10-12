<script setup lang="ts">
import type { ThreadPendingQuestion } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-006): the pending-question card. The file and public contract (props +
 * `answer(requestId, text)` emit) are created here; the creator answering UI is completed in
 * US-007. The question text is runner/agent text: `{{ }}` interpolation only (B4-D1).
 */
const props = defineProps<{ question: ThreadPendingQuestion; isCreator: boolean }>()
// The `answer(requestId, text)` emit is part of the public contract (US-007 completes the
// creator answering UI). Called without assignment: no caller exists until that story.
defineEmits<{
  (event: 'answer', requestId: string, text: string): void
}>()
</script>

<template>
  <div class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-question" role="status">
    <p class="whitespace-pre-wrap break-words">{{ props.question.text }}</p>
  </div>
</template>