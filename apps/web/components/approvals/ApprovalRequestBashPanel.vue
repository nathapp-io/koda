<template>
  <div class="space-y-3 text-sm" data-testid="approval-request-bash-panel">
    <NuxtLink
      v-if="jobHref !== null"
      :to="jobHref"
      class="text-primary underline-offset-4 hover:underline"
      data-testid="approval-request-bash-job"
    >{{ t('approvals.fleet.bash.openJob') }}</NuxtLink>

    <p v-if="payload === null" class="text-status-rejected" data-testid="approval-request-bash-unreadable">
      {{ t('approvals.fleet.bash.unreadable') }}
    </p>
    <template v-else>
      <div v-if="payload.command !== ''" class="space-y-1">
        <p class="font-medium">{{ t('approvals.fleet.bash.command') }}</p>
        <pre
          class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs"
          data-testid="approval-request-bash-command"
        >{{ payload.command }}</pre>
      </div>
      <div v-else class="space-y-1">
        <p class="font-medium">{{ t('approvals.fleet.bash.rawDetail') }}</p>
        <p class="text-muted-foreground" data-testid="approval-request-bash-raw-hint">{{ t('approvals.fleet.bash.rawHint') }}</p>
        <pre
          class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs"
          data-testid="approval-request-bash-raw"
        >{{ payload.rawDetail }}</pre>
      </div>
      <p v-if="payload.maskedCount > 0" class="text-muted-foreground" data-testid="approval-request-bash-masked">
        {{ t('approvals.fleet.bash.masked', { count: payload.maskedCount }) }}
      </p>
      <p v-if="payload.commandTruncated" class="text-status-rejected" data-testid="approval-request-bash-truncated">
        {{ t('approvals.fleet.bash.truncated') }}
      </p>
      <dl class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.bash.root') }}</dt><dd class="break-all font-mono text-xs">{{ payload.root }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.bash.stage') }}</dt><dd>{{ payload.stage }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.bash.story') }}</dt><dd>{{ payload.storyId ?? '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.bash.feature') }}</dt><dd class="break-all">{{ payload.featureName }}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted-foreground">{{ t('approvals.fleet.bash.reason') }}</dt><dd class="whitespace-pre-wrap break-all">{{ payload.reason }}</dd></div>
      </dl>
    </template>

    <p
      v-if="pending && left !== null"
      :class="left === 0 ? 'text-status-rejected' : 'text-muted-foreground'"
      data-testid="approval-request-bash-countdown"
    >
      {{ left === 0 ? t('approvals.fleet.bash.timedOut') : t('approvals.fleet.bash.expiresIn', { time: countdownText(left) }) }}
    </p>

    <template v-if="pending && canDecide && left !== 0">
      <div class="space-y-1">
        <Label :for="commentId">{{ t('approvals.fleet.bash.comment') }}</Label>
        <Textarea :id="commentId" v-model="comment" rows="2" :disabled="busy" data-testid="approval-request-bash-comment" />
        <p v-if="commentError" class="text-xs text-status-rejected" data-testid="approval-request-bash-comment-error">{{ commentError }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="choice in choices"
          :key="choice"
          :variant="choice === 'allow' ? 'default' : 'outline'"
          :disabled="busy"
          :data-testid="`approval-request-bash-${choice}`"
          @click="decide(choice)"
        >
          {{ t(`approvals.fleet.bash.${choice}`) }}
        </Button>
      </div>
    </template>
    <p v-else-if="pending && !canDecide" class="text-muted-foreground" data-testid="approval-request-bash-readonly">
      {{ t('approvals.fleet.bash.readOnly') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-004: one `fleet.job.shell.escalate` request, decided through the engine.
 *
 * The ask is nax's, so the panel words nothing itself: `bashAskOf` parses the frozen payload with the
 * same `bashPayload` the fleet inbox used, and `bashChoices` decides which options nax offered — a
 * command too long to read is deny-only. Answering emits the engine body; the inbox posts it.
 */
import { computed, ref } from 'vue'
import { bashChoices, countdownText, secondsLeft } from '~/lib/fleet-approvals'
import type { BashDecision } from '~/lib/fleet-approvals'
import { bashAskOf, bashRequestBody } from '~/lib/approval-request-fleet'
import { buildCommentSchema } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, DecideRequestBody } from '~/lib/approval-requests'

const props = defineProps<{
  request: ApprovalRequestDetail
  canDecide: boolean
  busy: boolean
  /** The inbox's 1-second clock, so the countdown does not need a timer of its own. */
  now: Date
  /** The project the request belongs to, when the surface showing it knows the slug. */
  projectSlug: string | null
}>()

const emit = defineEmits<{ (event: 'decide', body: DecideRequestBody): void }>()

const { t } = useI18n()

const ask = computed(() => bashAskOf(props.request))
const payload = computed(() => ask.value?.payload ?? null)
const choices = computed(() => bashChoices(payload.value))
const pending = computed(() => props.request.status === 'pending')
const left = computed(() => (pending.value ? secondsLeft(props.request.expiresAt, props.now) : null))
/** The job the ask belongs to, linked only where the surface knows the project it lives in. */
const jobHref = computed(() => {
  const jobId = ask.value?.jobId ?? null
  if (jobId === null || props.projectSlug === null) return null
  return `/${encodeURIComponent(props.projectSlug)}/fleet/jobs/${encodeURIComponent(jobId)}`
})

const comment = ref('')
const commentError = ref('')
/** D243-equivalent: schema-backed validation (.nax/rules/web.md), built once per mounted panel. */
const commentSchema = buildCommentSchema(t)
/** SSR-safe unique id, so the comment label binds to this panel's textarea only. */
const commentId = useId()

function decide(choice: BashDecision): void {
  const result = commentSchema.safeParse({ comment: comment.value })
  if (!result.success) {
    commentError.value = result.error.issues[0]?.message ?? ''
    return
  }
  commentError.value = ''
  emit('decide', bashRequestBody(choice, result.data.comment))
}
</script>
