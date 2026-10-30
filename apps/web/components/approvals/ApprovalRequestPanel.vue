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
    <template v-if="actions.decide || actions.cancel">
      <form v-if="actions.decide" class="space-y-2" @submit.prevent="approve">
        <label for="approval-request-comment">{{ t('approvals.panel.comment') }}</label>
        <Textarea id="approval-request-comment" v-model="comment" :disabled="busy" :placeholder="t('approvals.panel.commentPlaceholder')" data-testid="approval-request-comment" />
        <p v-if="commentError" class="text-status-rejected" data-testid="approval-request-comment-error">{{ commentError }}</p>
        <div class="flex flex-wrap gap-2">
          <Button type="submit" :disabled="busy" data-testid="approval-request-approve">{{ t('approvals.panel.approve') }}</Button>
          <Button type="button" variant="outline" :disabled="busy" data-testid="approval-request-reject" @click="reject">{{ t('approvals.panel.reject') }}</Button>
        </div>
      </form>
      <Button v-if="actions.cancel" type="button" variant="outline" :disabled="busy" data-testid="approval-request-cancel" @click="$emit('cancel')">{{ t('approvals.panel.cancel') }}</Button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildCommentSchema, viewerActions } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, DecideRequestBody } from '~/lib/approval-requests'

const props = defineProps<{ request: ApprovalRequestDetail; userId: string | null; busy: boolean }>()
const emit = defineEmits<{ (event: 'decide', body: DecideRequestBody): void; (event: 'cancel'): void }>()
const { t } = useI18n()
const comment = ref('')
const commentError = ref('')
const actions = computed(() => viewerActions(props.request, props.userId))
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
