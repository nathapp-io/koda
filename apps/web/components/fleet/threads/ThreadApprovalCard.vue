<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import type { ThreadActionResult } from '~/lib/thread-controller'
import type { ThreadApprovalDecision, ThreadPendingApprovalDto } from '~/lib/thread-types'

/**
 * thread-agents-modes US-012: one answerable session approval of a thread (US-007 keeps the list, US-008 the route).
 *
 * Every field is runner/agent text — the tool name, its summary, the command and the reason the runner gives — so all of
 * it renders through `{{ }}` interpolation only (B4-D1). The decision goes through the shared thread controller, which
 * builds the endpoint for the thread's own scope: `/projects/<slug>/threads/<id>/approvals/<requestId>` for a PROJECT or
 * REPO thread, `/threads/<id>/approvals/<requestId>` for a WORKSPACE one.
 *
 * Approve sends `allow` and Deny sends `deny` (US-008). Only the creator decides, like the pending question; anyone else
 * sees the request and the awaiting line. The API still enforces `thread.answer` and refuses a stale request, and its
 * message is shown on the card so the person can see why the decision did not land.
 */
const props = defineProps<{
  approval: ThreadPendingApprovalDto
  canDecide: boolean
  decide: (requestId: string, decision: ThreadApprovalDecision) => Promise<ThreadActionResult>
}>()
const { t } = useI18n()

const busy = ref(false)
/** A decided request leaves the transcript at once; the next live `thread` event reloads the thread's list. */
const decided = ref(false)
const errorText = ref('')

async function send(decision: ThreadApprovalDecision): Promise<void> {
  if (busy.value || decided.value) return
  busy.value = true
  errorText.value = ''
  try {
    const result = await props.decide(props.approval.requestId, decision)
    if (result.ok) decided.value = true
    else errorText.value = extractApiError(result.error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!decided" class="rounded-md border border-border bg-card p-3 text-sm" data-testid="thread-approval">
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
      <Button size="sm" :disabled="busy" data-testid="thread-approval-approve" @click="send('allow')">
        {{ t('fleet.threads.approval.approve') }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy" data-testid="thread-approval-deny" @click="send('deny')">
        {{ t('fleet.threads.approval.deny') }}
      </Button>
    </div>
    <p v-else class="mt-2 text-muted-foreground" data-testid="thread-approval-awaiting">{{ t('fleet.threads.approval.awaiting') }}</p>
    <p v-if="errorText" class="mt-1 text-xs text-status-rejected" role="alert" data-testid="thread-approval-error">{{ errorText }}</p>
  </div>
</template>
