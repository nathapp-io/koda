<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useFleetApprovals } from '~/composables/useFleetApprovals'
import { countdownText, secondsLeft, toActionBody } from '~/lib/fleet-approvals'
import type { PendingActionDto } from '~/lib/thread-types'

/**
 * Fleet S5b §2aw-D11 (US-005): one pending assistant action of a thread, with the decision only its requester may take
 * (2a-R2). The card is read by everyone who can open the thread; `canDecide` is the thread page's `isCreator`.
 *
 * The preview and the title ride runner/agent text, so they render through `{{ }}` interpolation only (B4-D1).
 * The approvals are the ones of the project the ACTION acts in (`action.projectSlug`), never the page's slug: a
 * WORKSPACE thread's action may act in another project, and the decision has to land on the action's own approval.
 */
const props = defineProps<{
  action: PendingActionDto
  canDecide: boolean
  /** The 1-second clock the thread timeline owns (`useApprovalCountdown`), for the expiry line. */
  now: Date
}>()

const { t } = useI18n()
const toast = useAppToast()
const approvals = useFleetApprovals({ kind: 'project', slug: props.action.projectSlug })

/** A decided card leaves the transcript at once; the thread's live `thread` frame then reloads `pendingActions`. */
const decided = ref(false)
const deciding = ref(false)

/** Only a decision this viewer may take AND an action `propose` has linked to an approval is offered (2a-R2). */
const canDecideNow = computed(() => props.canDecide && props.action.approvalId !== null)
const expiresIn = computed(() => {
  const seconds = secondsLeft(props.action.expiresAt, props.now)
  return seconds === null ? null : countdownText(seconds)
})

/** Approves or rejects the action; a failure toasts the API's own message and leaves the card decidable (2aw-D11). */
async function decide(decision: 'approve' | 'reject'): Promise<void> {
  if (props.action.approvalId === null || deciding.value) return
  deciding.value = true
  try {
    await approvals.decide(props.action.approvalId, toActionBody(decision, ''))
    decided.value = true
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  } finally {
    deciding.value = false
  }
}
</script>

<template>
  <div v-if="!decided" class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-action">
    <p class="font-medium" data-testid="thread-action-title">{{ t('fleet.threads.action.title', { tool: props.action.tool }) }}</p>
    <p class="mt-1 whitespace-pre-wrap break-words" data-testid="thread-action-preview">{{ props.action.preview }}</p>
    <p v-if="expiresIn !== null" class="mt-1 text-xs text-muted-foreground" data-testid="thread-action-expires">
      {{ t('fleet.threads.action.expiresIn', { time: expiresIn }) }}
    </p>
    <div v-if="canDecideNow" class="mt-2 flex items-center gap-2">
      <Button size="sm" :disabled="deciding" data-testid="thread-action-approve" @click="decide('approve')">
        {{ t('fleet.threads.action.approve') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="deciding" data-testid="thread-action-reject" @click="decide('reject')">
        {{ t('fleet.threads.action.reject') }}
      </Button>
    </div>
    <p v-else class="mt-2 text-muted-foreground" data-testid="thread-action-awaiting">{{ t('fleet.threads.action.awaiting') }}</p>
  </div>
</template>
