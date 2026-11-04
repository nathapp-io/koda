<script setup lang="ts">
import { computed, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import type { ThreadApprovalDecision, ThreadApprovalDelivery, ThreadPendingApprovalDto } from '~/lib/thread-types'

/**
 * thread-agents-modes US-012: one answerable session approval of a thread (US-007 keeps the list, US-008 the route).
 *
 * Every field is runner/agent text — the tool name, its summary, the command, the reason the runner gives, and the
 * detail of a refused decision — so all of it renders through `{{ }}` interpolation only (B4-D1). The decision goes
 * through the shared thread controller, which builds the endpoint for the thread's own scope:
 * `/projects/<slug>/threads/<id>/approvals/<requestId>` for a PROJECT or REPO thread, `/threads/<id>/approvals/<requestId>`
 * for a WORKSPACE one.
 *
 * Approve sends `allow` and Deny sends `deny` (US-008). The page decides who may press them (`ThreadDto`'s creator with
 * the own-row `thread.answer`, or any-row holder — branch fix B4); anyone else sees the request and the awaiting line. The
 * API still enforces `thread.answer` and the live session's requester, and its message is shown on the card so the person
 * can see why the decision did not land.
 *
 * Branch fix B3: a `200` means the decision was QUEUED to the runner, not applied. The card therefore never hides itself
 * while the request is still in `pendingApprovals`; it says the decision is queued until the runner's own acknowledgement
 * arrives on the thread (`approval.delivery`, B3 review round 2). A rejected acknowledgement clears the queued mark, is
 * worded on the card, and re-enables both decisions so the request can be decided again; an `ok` one keeps the card
 * waiting for the session to resolve the request. `supersededDelivery` is what keeps a resend honest: the outcome the
 * card already held when the new attempt started belongs to the previous attempt, so it is not shown as this one's.
 */
const props = defineProps<{
  approval: ThreadPendingApprovalDto
  canDecide: boolean
  decide: (requestId: string, decision: ThreadApprovalDecision) => Promise<ThreadActionResult>
}>()
const { t } = useI18n()

/** Identifies one acknowledgement, so a reloaded copy of the same outcome is not mistaken for a new one. */
function deliveryKeyOf(delivery: ThreadApprovalDelivery | undefined): string {
  return delivery === undefined ? '' : `${delivery.decision}|${delivery.result}|${delivery.detail ?? ''}|${delivery.at}`
}

const busy = ref(false)
/** The API accepted a decision for this request; it stays true until the page drops the request or the runner refuses. */
const sent = ref(false)
/** The acknowledgement the card already held when the current attempt started: an identical one is not this attempt's. */
const supersededDelivery = ref('')
/** The decision to resend, so a dropped or rejected acknowledgement can be sent again by hand. */
const lastDecision = ref<ThreadApprovalDecision | null>(null)
/** The API's own refusal of the last send (the immediate 4xx), shown next to the runner's, never merged with it. */
const errorText = ref('')

/** The runner's rejection of the last attempt, or null when there is none to show. */
const rejection = computed<ThreadApprovalDelivery | null>(() => {
  const delivery = props.approval.delivery
  if (delivery === undefined || delivery.result !== 'rejected') return null
  return deliveryKeyOf(delivery) === supersededDelivery.value ? null : delivery
})

/** Queued: the API took the decision and the runner has not refused it. */
const queued = computed(() => sent.value && rejection.value === null)

/** The rejection in words; the runner's detail is its own text, so it is interpolated, never rendered as markup. */
const rejectionText = computed(() => {
  const refused = rejection.value
  if (refused === null) return ''
  return refused.detail === null
    ? t('fleet.threads.approval.rejectedNoDetail')
    : t('fleet.threads.approval.rejected', { detail: refused.detail })
})

async function send(decision: ThreadApprovalDecision): Promise<void> {
  if (busy.value) return
  busy.value = true
  errorText.value = ''
  lastDecision.value = decision
  supersededDelivery.value = deliveryKeyOf(props.approval.delivery)
  try {
    const result = await props.decide(props.approval.requestId, decision)
    if (result.ok) sent.value = true
    else errorText.value = extractApiError(result.error)
  } finally {
    busy.value = false
  }
}

/** Send the last decision again, for a request the session has not resolved. */
function resend(): void {
  if (lastDecision.value !== null) void send(lastDecision.value)
}
</script>

<template>
  <div class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-approval">
    <div class="flex items-center gap-2">
      <p class="font-medium whitespace-pre-wrap break-words" data-testid="thread-approval-tool">{{ props.approval.tool }}</p>
      <Badge v-if="props.approval.unsandboxed" variant="outline" data-testid="thread-approval-unsandboxed">
        {{ t('fleet.threads.approval.unsandboxed') }}
      </Badge>
    </div>
    <p class="mt-1 whitespace-pre-wrap break-words" data-testid="thread-approval-summary">{{ props.approval.summary }}</p>
    <p v-if="props.approval.command" class="mt-1 text-xs text-muted-foreground" data-testid="thread-approval-command">
      <span class="font-medium">{{ t('fleet.threads.approval.command') }}</span>
      <span class="ml-1 whitespace-pre-wrap break-words">{{ props.approval.command }}</span>
    </p>
    <p v-if="props.approval.reason" class="mt-1 text-xs text-muted-foreground" data-testid="thread-approval-reason">
      <span class="font-medium">{{ t('fleet.threads.approval.reason') }}</span>
      <span class="ml-1 whitespace-pre-wrap break-words">{{ props.approval.reason }}</span>
    </p>
    <div v-if="props.canDecide" class="mt-2 flex items-center gap-2">
      <Button size="sm" :disabled="busy || queued" data-testid="thread-approval-approve" @click="send('allow')">
        {{ t('fleet.threads.approval.approve') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy || queued" data-testid="thread-approval-deny" @click="send('deny')">
        {{ t('fleet.threads.approval.deny') }}
      </Button>
      <Button v-if="queued" variant="ghost" size="sm" :disabled="busy" data-testid="thread-approval-retry" @click="resend()">
        {{ t('fleet.threads.approval.retry') }}
      </Button>
    </div>
    <p v-else class="mt-2 text-muted-foreground" data-testid="thread-approval-awaiting">{{ t('fleet.threads.approval.awaiting') }}</p>
    <p v-if="queued" class="mt-1 text-xs text-muted-foreground" data-testid="thread-approval-queued">{{ t('fleet.threads.approval.queued') }}</p>
    <p v-if="rejectionText" class="mt-1 text-xs text-status-rejected" role="alert" data-testid="thread-approval-rejected">{{ rejectionText }}</p>
    <p v-if="errorText" class="mt-1 text-xs text-status-rejected" role="alert" data-testid="thread-approval-error">{{ errorText }}</p>
  </div>
</template>
