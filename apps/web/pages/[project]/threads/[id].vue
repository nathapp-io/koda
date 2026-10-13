<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import { composerState, isTurnRunning, sessionLabel } from '~/lib/thread-view'

/**
 * Fleet S5a §4.62 (US-007): the thread detail page — the live header and transcript, the
 * session controls and the composer.
 *
 * The runner summaries (for the header's runner name and online dot) load with the page;
 * the dot follows those summaries and does not live-update. The tab title gains a `• `
 * prefix while a turn runs (`isTurnRunning`). Every action emit binds to the matching
 * `useThread()` method and toasts `extractApiError(error)` for each `{ ok: false, error }`
 * result; state reloads on the next event.
 */
definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const threadId = route.params.id as string
const controller = useThread(slug, threadId)
const options = useFleetDispatchOptions(slug)
const auth = useAuth()
const { data: viewer } = useProjectViewerRole(slug)
const toast = useAppToast()

const isCreator = computed(() => controller.thread.value !== null && controller.thread.value.createdById === auth.user.value?.id)
const canManage = computed(() => viewer.value?.canManage === true)

useHead(() => ({
  title: isTurnRunning(controller.messages.value) ? `• ${controller.thread.value?.title ?? ''}` : controller.thread.value?.title ?? '',
}))

onMounted(() => {
  // useThread owns the thread lifecycle (load then start on mount with the EventSource guard,
  // stop on unmount); the page only loads the runner summaries the header's online dot reads.
  // A failed summaries load degrades gracefully: the header omits the runner line, and the turn
  // state is untouched (the stream and poll fallback are the controller's).
  void options.load().catch(() => undefined)
})

/** Run one useThread action; every `{ ok: false, error }` result is toasted with extractApiError. */
async function runAction(action: () => Promise<ThreadActionResult>): Promise<void> {
  const result = await action()
  if (!result.ok) toast.error(extractApiError(result.error))
}

const onSend = (text: string): Promise<void> => runAction(() => controller.send(text))
const onStop = (): Promise<void> => runAction(() => controller.stopTurn())
const onEndSession = (): Promise<void> => runAction(() => controller.endSession())
const onAnswer = (requestId: string, text: string): Promise<void> => runAction(() => controller.answer(requestId, text))
const onRaiseCap = (value: number): Promise<void> => runAction(() => controller.raiseCap(value))
const onArchive = (): Promise<void> => runAction(() => controller.archive())
</script>

<template>
  <div class="space-y-5">
    <template v-if="controller.thread.value">
      <FleetThreadsThreadHeader :thread="controller.thread.value" :runners="options.runners.value" />
      <FleetThreadsThreadControls
        :is-creator="isCreator"
        :can-manage="canManage"
        :session-label="sessionLabel(controller.thread.value)"
        :archived="controller.thread.value.archivedAt !== null"
        @end-session="onEndSession"
        @raise-cap="onRaiseCap"
        @archive="onArchive"
      />
      <FleetThreadsThreadTimeline
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
        @answer="onAnswer"
      />
      <FleetThreadsThreadComposer
        :composer-state="composerState(controller.thread.value, controller.messages.value, { isCreator })"
        :turn-running="isTurnRunning(controller.messages.value)"
        @send="onSend"
        @stop="onStop"
      />
    </template>
  </div>
</template>