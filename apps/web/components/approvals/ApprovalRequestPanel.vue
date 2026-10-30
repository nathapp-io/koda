<template>
  <section class="space-y-4 text-sm" data-testid="approval-request-panel">
    <div>
      <h3 class="font-medium">{{ t('approvals.panel.input') }}</h3>
      <pre class="mt-2 whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs" data-testid="approval-request-input">{{ inputText }}</pre>
    </div>
    <div v-if="request.decisions.length" class="space-y-2">
      <h3 class="font-medium">{{ t('approvals.panel.decisions') }}</h3>
      <ul class="space-y-1" data-testid="approval-request-decisions">
        <li v-for="decision in request.decisions" :key="decision.id">
          <span>{{ decision.deciderId }}</span> · <span>{{ decision.decision }}</span><span v-if="decision.comment !== null"> · {{ decision.comment }}</span>
        </li>
      </ul>
    </div>
    <!-- US-004: a fleet key decides through its own panel, worded from the payload it froze. -->
    <ApprovalRequestBashPanel
      v-if="kind === 'bash'"
      :request="request"
      :can-decide="actions.decide"
      :busy="busy"
      :now="now"
      :project-slug="projectSlug ?? null"
      @decide="emit('decide', $event)"
    />
    <ApprovalRequestBudgetPanel
      v-else-if="kind === 'budget'"
      :request="request"
      :can-decide="actions.decide"
      :busy="busy"
      @decide="emit('decide', $event)"
    />
    <form v-else-if="actions.decide" class="space-y-2" @submit.prevent="approve">
      <label for="approval-request-comment">{{ t('approvals.panel.comment') }}</label>
      <Textarea id="approval-request-comment" v-model="comment" :disabled="busy" :placeholder="t('approvals.panel.commentPlaceholder')" data-testid="approval-request-comment" />
      <p v-if="commentError" class="text-status-rejected" data-testid="approval-request-comment-error">{{ commentError }}</p>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" :disabled="busy" data-testid="approval-request-approve">{{ t('approvals.panel.approve') }}</Button>
        <Button type="button" variant="outline" :disabled="busy" data-testid="approval-request-reject" @click="reject">{{ t('approvals.panel.reject') }}</Button>
      </div>
    </form>
    <Button v-if="actions.cancel" type="button" variant="outline" :disabled="busy" data-testid="approval-request-cancel" @click="emit('cancel')">{{ t('approvals.panel.cancel') }}</Button>
    <!-- US-004: a settled fleet request shows what became of it, and nothing left to answer. -->
    <ApprovalRequestOutcome v-if="settled && kind !== 'generic'" :request="request" />
  </section>
</template>

<script setup lang="ts">
/**
 * P3b US-003, extended by US-004: the decide surface of one engine request.
 *
 * The generic form (a comment, Approve and Reject) is all most keys need. The two fleet keys carry a
 * payload the generic form cannot word — a bash ask offers nax's own choices, a budget stop asks for a
 * raised limit — so `requestPanelKind` picks their panel, and a settled fleet request shows its
 * outcome. This panel never posts: it emits the engine body and the inbox sends it.
 */
import { computed, ref } from 'vue'
import { useApprovalCountdown } from '~/composables/useApprovalCountdown'
import { requestPanelKind } from '~/lib/approval-request-fleet'
import { buildCommentSchema, viewerActions } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, DecideRequestBody } from '~/lib/approval-requests'

const props = defineProps<{
  request: ApprovalRequestDetail
  userId: string | null
  busy: boolean
  /** The request's project slug, when the surface knows it: what a bash ask links its job with. */
  projectSlug?: string | null
}>()
const emit = defineEmits<{ (event: 'decide', body: DecideRequestBody): void; (event: 'cancel'): void }>()
const { t } = useI18n()
const { now } = useApprovalCountdown()
const comment = ref('')
const commentError = ref('')
const actions = computed(() => viewerActions(props.request, props.userId))
const kind = computed(() => requestPanelKind(props.request))
const settled = computed(() => props.request.status !== 'pending')
const inputText = computed(() => JSON.stringify(props.request.input, null, 2) ?? 'undefined')
const commentSchema = computed(() => buildCommentSchema(t))

function body(decision: 'approve' | 'reject'): void {
  const result = commentSchema.value.safeParse({ comment: comment.value })
  if (!result.success) {
    commentError.value = result.error.issues[0]?.message ?? ''
    return
  }
  commentError.value = ''
  const trimmed = result.data.comment.trim()
  emit('decide', { decision, ...(trimmed === '' ? {} : { comment: trimmed }) })
}
function approve(): void { body('approve') }
function reject(): void { body('reject') }
</script>
