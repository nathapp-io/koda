<script setup lang="ts">
import { computed, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import { composerState, isTurnRunning, sessionLabel } from '~/lib/thread-view'

/**
 * Fleet S5b 1d (US-006, 1d2-D12): the personal WORKSPACE thread page — the live header, the session
 * controls, the koda tools notice, the transcript and the composer.
 *
 * A WORKSPACE thread is not project-scoped: the thread and its messages live on the top-level
 * `/threads/:id` routes (`useWorkspaceThread`, US-004), which owns the load, the live stream and the
 * actions. The page therefore has no project slug, no handoff (no Publish, Plan, Run or Discard), no
 * stale banner and no project-code notice — none of them exist for a WORKSPACE thread — and its
 * creator is the only possible viewer, so a loaded thread is the viewer's own.
 *
 * The header's runner summaries come from the thread's home project (`GET
 * /projects/<homeProject.slug>/fleet/runners`), read only once the thread is in hand: the slug is
 * what addresses the read, and a pending or 404 thread must not send it. Job cards in the transcript
 * link into that same home project, which is why `ThreadTimeline` receives its slug.
 *
 * Every `{ ok: false, error }` action result is toasted with `extractApiError(error)`, and the tab
 * title gains a `• ` prefix while a turn runs (`isTurnRunning`).
 */
definePageMeta({ layout: 'default' })

const route = useRoute()
const threadId = route.params.id as string
const controller = useWorkspaceThread(threadId)
const runnerSummaries = useProjectRunnerSummaries()
const toast = useAppToast()

/** The creator is the only possible viewer of a WORKSPACE thread, so a loaded thread is theirs. */
const isCreator = computed(() => controller.thread.value !== null)

useHead(() => ({
  title: isTurnRunning(controller.messages.value) ? `• ${controller.thread.value?.title ?? ''}` : controller.thread.value?.title ?? '',
}))

watch(() => controller.thread.value?.homeProject?.slug ?? null, (slug) => {
  if (slug === null) return
  // A failed summaries load degrades gracefully: the header omits the runner line and its dot, and
  // the turn state is untouched (the stream and the polling fallback are the controller's).
  void runnerSummaries.load(slug).catch(() => undefined)
})

/** Run one controller action; every `{ ok: false, error }` result is toasted with extractApiError. */
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
      <FleetThreadsThreadHeader :thread="controller.thread.value" :runners="runnerSummaries.runners.value" />
      <FleetThreadsThreadControls
        :is-creator="isCreator"
        :can-manage="false"
        :session-label="sessionLabel(controller.thread.value)"
        :archived="controller.thread.value.archivedAt !== null"
        @end-session="onEndSession"
        @raise-cap="onRaiseCap"
        @archive="onArchive"
      />
      <FleetThreadsThreadKodaToolsNotice :thread="controller.thread.value" />
      <FleetThreadsThreadTimeline
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
        :slug="controller.thread.value.homeProject?.slug ?? ''"
        @answer="onAnswer"
      />
      <FleetThreadsThreadComposer
        :composer-state="composerState(controller.thread.value, controller.messages.value, { isCreator })"
        :turn-running="isTurnRunning(controller.messages.value)"
        @send="onSend"
        @stop="onStop"
      />
    </template>
    <ErrorState v-else-if="controller.loadFailed.value" @retry="controller.loadThread()" />
    <LoadingState v-else />
  </div>
</template>
