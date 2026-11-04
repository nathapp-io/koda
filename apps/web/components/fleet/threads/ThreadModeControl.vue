<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import type { ThreadDto, ThreadMode } from '~/lib/thread-types'

/**
 * thread-agents-modes US-012: the REPO thread's execution-profile control (Read, Ask, Full).
 *
 * A thread's mode decides how much its turns may do — `read` answers and writes nothing, `ask` proposes, `full` edits —
 * so changing it is a permissioned action (US-005): the page passes the modes this caller holds a key for (`read` needs
 * `thread.cap.update`, `ask`/`full` their own `thread.mode.*`) in `allowed`, and the ones outside it render disabled.
 *
 * The transport is the shared thread controller's `changeMode` (`PATCH /projects/<slug>/threads/<id>/mode`), so this
 * control never builds an API path itself. A refused change — a running turn answers 409 — renders the API's own text
 * inside the control instead of toasting it: the message belongs next to the choice the person just made.
 */
const props = defineProps<{
  thread: ThreadDto
  /** The modes this caller may switch to; a mode outside it is rendered disabled. */
  allowed: ThreadMode[]
  changeMode: (mode: ThreadMode) => Promise<ThreadActionResult>
}>()
const { t } = useI18n()

/** Display order of the control; the values match the API's `ThreadMode`. */
const MODES: ThreadMode[] = ['read', 'ask', 'full']

const current = computed<ThreadMode>(() => props.thread.mode ?? 'read')
const busy = ref(false)
const errorText = ref('')

/** `mode` is what the caller asked for; a no-op, a disabled mode or an in-flight change never reaches the API. */
async function select(mode: ThreadMode): Promise<void> {
  if (busy.value || mode === current.value || !props.allowed.includes(mode)) return
  busy.value = true
  errorText.value = ''
  try {
    const result = await props.changeMode(mode)
    if (!result.ok) errorText.value = extractApiError(result.error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-mode">
    <div class="flex items-center gap-2" role="group" :aria-label="t('fleet.threads.mode.label')">
      <span class="text-xs font-medium text-muted-foreground">{{ t('fleet.threads.mode.label') }}</span>
      <Button
        v-for="mode in MODES"
        :key="mode"
        :variant="mode === current ? 'default' : 'outline'"
        size="sm"
        :disabled="busy || !props.allowed.includes(mode)"
        :aria-pressed="mode === current ? 'true' : 'false'"
        :title="props.allowed.includes(mode) ? undefined : t('fleet.threads.mode.noPermission')"
        :data-testid="`thread-mode-${mode}`"
        @click="select(mode)"
      >
        {{ t(`fleet.threads.mode.${mode}`) }}
      </Button>
    </div>
    <p v-if="errorText" class="mt-1 text-xs text-status-rejected" role="alert" data-testid="thread-mode-error">{{ errorText }}</p>
  </div>
</template>
