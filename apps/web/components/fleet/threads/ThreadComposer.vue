<script setup lang="ts">
import { ref } from 'vue'
import type { ComposerReason } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-007): the thread composer — the creator's message box and the
 * viewer's read-only note.
 *
 * Contract: props `composerState: { canSend, reason }` (`reason` is a `ComposerReason`:
 * a `ThreadSendRefusal` or `readOnly`) and `turnRunning: boolean`; emits `send(text)`
 * and `stop`. Enter sends the trimmed draft, Shift+Enter inserts a newline (never
 * sends), whitespace sends nothing, a refusing `composerState` renders the
 * `fleet.threads.refusal.<reason>` text, a readOnly state renders
 * `fleet.threads.composer.readOnly` instead of a textarea, and a running turn renders
 * a Stop control that emits `stop`. The refusal reason comes from the thread view
 * (`composerState` in `~/lib/thread-view`), never a copied server send rule.
 */
const props = defineProps<{
  composerState: { canSend: boolean; reason: ComposerReason | null }
  turnRunning: boolean
}>()
const emit = defineEmits<{
  (event: 'send', text: string): void
  (event: 'stop'): void
}>()
const { t } = useI18n()

const draft = ref('')

function handleInput(event: Event): void {
  draft.value = (event.target as HTMLTextAreaElement).value
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (event.shiftKey) return
  const text = draft.value.trim()
  if (!props.composerState.canSend || text.length === 0) return
  emit('send', text)
}

function sendDraft(): void {
  const text = draft.value.trim()
  if (!props.composerState.canSend || text.length === 0) return
  emit('send', text)
}

function stop(): void {
  emit('stop')
}
</script>

<template>
  <div class="space-y-2" data-testid="thread-composer">
    <p v-if="props.composerState.reason === 'readOnly'" class="text-sm text-muted-foreground">
      {{ t('fleet.threads.composer.readOnly') }}
    </p>
    <template v-else>
      <p v-if="props.composerState.reason !== null" class="text-sm text-muted-foreground" role="status">
        {{ t(`fleet.threads.refusal.${props.composerState.reason}`) }}
      </p>
      <Textarea
        :model-value="draft"
        :placeholder="t('fleet.threads.composer.placeholder')"
        :disabled="!props.composerState.canSend"
        class="min-h-[80px] text-sm"
        data-testid="thread-composer-input"
        @input="handleInput"
        @keydown="handleKeydown"
      />
      <div class="flex justify-end gap-2">
        <Button
          v-if="props.turnRunning"
          type="button"
          variant="outline"
          data-testid="thread-stop"
          @click="stop"
        >{{ t('fleet.threads.composer.stop') }}</Button>
        <Button
          type="button"
          :disabled="!props.composerState.canSend || draft.trim().length === 0"
          data-testid="thread-send"
          @click="sendDraft"
        >{{ t('fleet.threads.composer.send') }}</Button>
      </div>
    </template>
  </div>
</template>