<template>
  <div class="space-y-3 text-sm" data-testid="fleet-approval-bash-panel">
    <NuxtLink v-if="jobHref" :to="jobHref" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-approval-bash-job">{{ t('fleet.approvals.bash.openJob') }}</NuxtLink>
    <p v-if="payload === null" class="text-destructive" data-testid="fleet-approval-bash-unreadable">{{ t('fleet.approvals.bash.unreadable') }}</p>
    <template v-else>
      <div v-if="payload.command !== ''" class="space-y-1">
        <p class="font-medium">{{ t('fleet.approvals.bash.command') }}</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="fleet-approval-bash-command">{{ payload.command }}</pre>
      </div>
      <div v-else class="space-y-1">
        <p class="font-medium">{{ t('fleet.approvals.bash.rawDetail') }}</p>
        <p class="text-muted-foreground" data-testid="fleet-approval-bash-raw-hint">{{ t('fleet.approvals.bash.rawHint') }}</p>
        <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs" data-testid="fleet-approval-bash-raw">{{ payload.rawDetail }}</pre>
      </div>
      <p v-if="payload.maskedCount > 0" class="text-muted-foreground" data-testid="fleet-approval-bash-masked">
        {{ t('fleet.approvals.bash.masked', { count: payload.maskedCount }) }}
      </p>
      <p v-if="payload.commandTruncated" class="text-destructive" data-testid="fleet-approval-bash-truncated">{{ t('fleet.approvals.bash.truncated') }}</p>
      <dl class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.root') }}</dt><dd class="break-all font-mono text-xs">{{ payload.root }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.stage') }}</dt><dd>{{ payload.stage }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.story') }}</dt><dd>{{ payload.storyId ?? '-' }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.feature') }}</dt><dd class="break-all">{{ payload.featureName }}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted-foreground">{{ t('fleet.approvals.bash.reason') }}</dt><dd class="whitespace-pre-wrap break-all">{{ payload.reason }}</dd></div>
      </dl>
    </template>

    <p v-if="left !== null" :class="left === 0 ? 'text-destructive' : 'text-muted-foreground'" data-testid="fleet-approval-bash-countdown">
      {{ left === 0 ? t('fleet.approvals.bash.timedOut') : t('fleet.approvals.bash.expiresIn', { time: countdownText(left) }) }}
    </p>

    <template v-if="canDecide && left !== 0">
      <div class="space-y-1">
        <Label :for="commentId">{{ t('fleet.approvals.budget.comment') }}</Label>
        <Textarea :id="commentId" v-model="comment" rows="2" data-testid="fleet-approval-comment" />
        <p v-if="commentInvalid" class="text-xs text-destructive" data-testid="fleet-approval-comment-error">{{ t('fleet.approvals.validation.commentTooLong') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button
          v-for="choice in choices"
          :key="choice"
          :variant="choice === 'allow' ? 'default' : 'outline'"
          :disabled="busy"
          :data-testid="`fleet-approval-bash-${choice}`"
          @click="decide(choice)"
        >
          {{ t(`fleet.approvals.bash.action.${choice}`) }}
        </Button>
      </div>
    </template>
    <p v-else-if="!canDecide" class="text-muted-foreground" data-testid="fleet-approval-readonly">{{ t('fleet.approvals.readOnlyBash') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { bashChoices, bashPayload, commentTooLong, countdownText, secondsLeft, toBashBody } from '~/lib/fleet-approvals'
import type { BashDecision } from '~/lib/fleet-approvals'
import type { DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

// Mounted per `${id}:${status}:${fetch}` by FleetApprovalInbox (D242, D250): the comment below is initialised once.
const props = defineProps<{
  approval: FleetApprovalDto
  canDecide: boolean
  busy: boolean
  /** The inbox's 1-second clock (D292). */
  now: Date
  /** The job page, when the inbox can link it (spec §5 "job link"). */
  jobHref?: string | null
}>()

const emit = defineEmits<{ (e: 'decide', body: DecideApprovalBody): void }>()

const { t } = useI18n()

const payload = computed(() => bashPayload(props.approval))
const choices = computed(() => bashChoices(payload.value))
const left = computed(() => secondsLeft(props.approval.expiresAt, props.now))
const comment = ref('')
const commentInvalid = computed(() => commentTooLong(comment.value))
/** SSR-safe unique id, so the comment label binds to this panel's textarea only. */
const commentId = useId()

function decide(choice: BashDecision): void {
  if (commentInvalid.value) return
  emit('decide', toBashBody(choice, comment.value))
}
</script>
