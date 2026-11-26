<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import { allowedThreadModes } from '~/lib/thread-mode-access'
import type { ThreadApprovalDecision, ThreadMode } from '~/lib/thread-types'
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
 *
 * thread-agents-modes US-012: a REPO thread also shows its mode control (the execution profile
 * its turns run with) and one approval card per pending session approval. The mode control is
 * limited to the modes the caller holds the key for — own-row grants included, and another
 * creator's thread needs the any-row `thread.cap.update` authority (`allowedThreadModes`) — and the
 * cards decide through the same controller, so both land on the project-scoped routes.
 */
definePageMeta({ layout: 'default' })

const route = useRoute()
const { t } = useI18n()
const slug = route.params.project as string
const threadId = route.params.id as string
const controller = useThread(slug, threadId)
const handoffJobs = useThreadHandoffJobs(slug, controller.thread)
useProjectEvents(slug, {
  onFleetJob: event => {
    if (!handoffJobs.isHandoffJob(event.jobId)) return
    void controller.reloadThread()
    void handoffJobs.refreshJob(event.jobId)
  },
  onResync: () => { void controller.reloadThread() },
})
const options = useFleetDispatchOptions(slug)
const auth = useAuth()
// Permissions P1 US-007: archiving ANY thread needs `thread.archive` in this project. `has` is the
// right question, never `hasOwn`: an `.own` binding only covers the caller's own threads, and the
// creator control (`isCreator`) is what covers those.
const { permissions } = useProjectPermissions(slug)
const toast = useAppToast()

const isCreator = computed(() => controller.thread.value !== null && controller.thread.value.createdById === auth.user.value?.id)
const canManage = computed(() => permissions.value.has('thread.archive'))
const mayActOnThread = (key: string) => isCreator.value ? permissions.value.hasOwn(key) : permissions.value.has(key)
const canSend = computed(() => mayActOnThread('thread.message.send'))
const canStop = computed(() => mayActOnThread('thread.stop'))

/**
 * US-012 (F1): the modes this viewer may switch to. Mirrors the API — the target key counts in its own-or-any-row form
 * for the thread's creator, and another creator's thread also needs the any-row `thread.cap.update` authority.
 */
const allowedModes = computed<ThreadMode[]>(() => allowedThreadModes(permissions.value, isCreator.value))
/** Only a REPO thread has a worktree to publish, so only it can run in a mode other than `read`. */
const showModeControl = computed(() => controller.thread.value?.kind === 'REPO')
const pendingApprovals = computed(() => controller.thread.value?.pendingApprovals ?? [])
// Both questions and session approvals steer the running job on its requester's behalf.
const canAnswer = computed(() => {
  const job = controller.thread.value?.activeJob
  return job?.state === 'RUNNING' && Boolean(job.requesterUserId)
    && job.requesterUserId === auth.user.value?.id && mayActOnThread('thread.answer')
})

let queuedRefreshTimer: ReturnType<typeof setInterval> | null = null
watch(() => controller.thread.value?.activeJob?.state === 'QUEUED', (queued) => {
  if (queuedRefreshTimer !== null) clearInterval(queuedRefreshTimer)
  queuedRefreshTimer = queued ? setInterval(() => { void controller.reloadThread() }, 30_000) : null
}, { immediate: true })
onBeforeUnmount(() => {
  if (queuedRefreshTimer !== null) clearInterval(queuedRefreshTimer)
  queuedRefreshTimer = null
})

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

/**
 * US-001: the send route is approval-gated, so `{ ok: false, pendingApproval }` means nothing was written
 * and nothing failed — the composer names the returned request itself, so no error is toasted here.
 */
const onSend = async (text: string): Promise<ThreadActionResult> => {
  const result = await controller.send(text)
  if (!result.ok && result.pendingApproval === undefined) toast.error(extractApiError(result.error))
  return result
}
const onStop = (): Promise<void> => runAction(() => controller.stopTurn())
const onEndSession = (): Promise<void> => runAction(() => controller.endSession())
const onAnswer = (requestId: string, text: string): Promise<void> => runAction(() => controller.answer(requestId, text))
const onChangeMode = (mode: ThreadMode): Promise<ThreadActionResult> => controller.changeMode(mode)
const onDecideApproval = (requestId: string, decision: ThreadApprovalDecision): Promise<ThreadActionResult> =>
  controller.decideApproval(requestId, decision)
const onRaiseCap = (value: number): Promise<void> => runAction(() => controller.raiseCap(value))
const onArchive = (): Promise<void> => runAction(() => controller.archive())
const onPublish = (): Promise<void> => runAction(() => controller.publish())
const onPlan = (body: import('~/lib/thread-handoff-form').ThreadHandoffBody): Promise<void> => runAction(() => controller.plan(body))
const onRun = (body: import('~/lib/thread-handoff-form').ThreadHandoffBody): Promise<void> => runAction(() => controller.run(body))
const onDiscard = (): Promise<void> => runAction(() => controller.discard())
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
        :max-cost-usd="controller.thread.value.maxCostUsd"
        @end-session="onEndSession"
        @raise-cap="onRaiseCap"
        @archive="onArchive"
      />
      <FleetThreadsThreadStaleBanner
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
        @discard="onDiscard"
      />
      <FleetThreadsThreadModeControl
        v-if="showModeControl"
        :thread="controller.thread.value"
        :allowed="allowedModes"
        :change-mode="onChangeMode"
      />
      <FleetThreadsThreadKodaToolsNotice
        :thread="controller.thread.value"
      />
      <FleetThreadsThreadProjectCodeNotice
        :thread="controller.thread.value"
      />
      <FleetThreadsThreadActionBar
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
        @publish="onPublish"
        @plan="onPlan"
        @run="onRun"
      />
      <FleetThreadsThreadQueuedNotice :thread="controller.thread.value" />
      <FleetThreadsThreadTimeline
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
        :can-answer="canAnswer"
        :jobs="handoffJobs.jobs.value"
        :slug="slug"
        @answer="onAnswer"
      />
      <div v-if="pendingApprovals.length > 0" class="space-y-3" data-testid="thread-approvals">
        <FleetThreadsThreadApprovalCard
          v-for="pending in pendingApprovals"
          :key="pending.requestId"
          :approval="pending"
          :can-decide="canAnswer"
          :decide="onDecideApproval"
        />
      </div>
      <FleetThreadsThreadComposer
        :composer-state="composerState(controller.thread.value, controller.messages.value, { canSend })"
        :show-stop="canStop && isTurnRunning(controller.messages.value)"
        :send="onSend"
        @stop="onStop"
      />
      <FleetThreadsThreadFlowsPanel :slug="slug" :thread-id="threadId" />
      <FleetThreadsThreadStartFlow :slug="slug" :thread="controller.thread.value" />
      <FleetThreadsThreadPreApprovalCard :slug="slug" :thread="controller.thread.value" @changed="controller.reloadThread()" />
    </template>
    <p v-else-if="controller.unavailable.value" role="status" class="text-sm text-muted-foreground">
      {{ t('fleet.threads.detail.unavailable') }}
    </p>
    <ErrorState v-else-if="controller.loadFailed.value" @retry="controller.loadThread()" />
    <LoadingState v-else-if="controller.loading.value" />
  </div>
</template>