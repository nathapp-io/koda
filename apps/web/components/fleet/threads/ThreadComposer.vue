<script setup lang="ts">
import { useField } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { buildThreadMessageSchema } from '~/lib/thread-create'
import type { ComposerReason } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-007): the thread composer — the creator's message box and the
 * viewer's read-only note.
 *
 * Contract: props `composerState: { canSend, reason }` (`reason` is a `ComposerReason`:
 * a `ThreadSendRefusal` or `readOnly`) and `turnRunning: boolean`; emits `send(text)`
 * and `stop`. Enter sends the validated draft, Shift+Enter inserts a newline (never
 * sends), whitespace sends nothing, a refusing `composerState` renders the
 * `fleet.threads.refusal.<reason>` text, a readOnly state renders
 * `fleet.threads.composer.readOnly` instead of a textarea, and a running turn renders
 * a Stop control that emits `stop`. The refusal reason comes from the thread view
 * (`composerState` in `~/lib/thread-view`), never a copied server send rule.
 *
 * US-007: the draft is validated with vee-validate + a zod schema
 * (`buildThreadMessageSchema`: trimmed, non-empty, at most 32768 UTF-8 bytes — the
 * API's limit), so an over-length draft is blocked client-side instead of being
 * rejected by the API after the fact.
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

const { value: draft, errorMessage, validate } = useField(
  'message',
  toTypedSchema(buildThreadMessageSchema(t)),
  { initialValue: '' },
)

/** Enter sends the validated draft; Shift+Enter inserts a newline at the cursor (never sends). */
function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return
  event.preventDefault()
  if (event.shiftKey) {
    const target = event.target as HTMLTextAreaElement | null
    const current = String(draft.value ?? '')
    const start = target?.selectionStart ?? current.length
    const end = target?.selectionEnd ?? current.length
    draft.value = `${current.slice(0, start)}\n${current.slice(end)}`
    return
  }
  void sendDraft()
}

/** Sends the trimmed draft when it passes the schema (non-empty, ≤32768 UTF-8 bytes). */
async function sendDraft(): Promise<void> {
  if (!props.composerState.canSend) return
  const { valid } = await validate()
  if (!valid) return
  emit('send', String(draft.value ?? '').trim())
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
        @update:model-value="draft = $event"
        @keydown="handleKeydown"
      />
      <p v-if="errorMessage" class="text-xs text-destructive" role="alert" data-testid="thread-composer-error">{{ errorMessage }}</p>
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
          :disabled="!props.composerState.canSend || String(draft ?? '').trim().length === 0"
          data-testid="thread-send"
          @click="sendDraft"
        >{{ t('fleet.threads.composer.send') }}</Button>
      </div>
    </template>
  </div>
</template>
