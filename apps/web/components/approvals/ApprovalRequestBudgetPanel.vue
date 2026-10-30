<template>
  <div class="space-y-4 text-sm" data-testid="approval-request-budget-panel">
    <div v-if="ask !== null" class="space-y-1" data-testid="approval-request-budget-summary">
      <p class="font-medium">{{ t('approvals.fleet.budget.summary', { scope: scopeText(t, ask, ask.scopeId) }) }}</p>
      <dl class="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-3">
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.budget.window') }}</dt><dd>{{ t(`fleet.budgets.window.${ask.windowKind}`) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.budget.spent') }}</dt><dd>{{ formatUsd(ask.spentUsd) }}</dd></div>
        <div><dt class="text-muted-foreground">{{ t('approvals.fleet.budget.asked') }}</dt><dd>{{ formatUsd(ask.amountUsd) }}</dd></div>
      </dl>
    </div>
    <p v-else class="text-status-rejected" data-testid="approval-request-budget-unreadable">
      {{ t('approvals.fleet.budget.unreadable') }}
    </p>

    <template v-if="pending && canDecide">
      <fieldset class="space-y-1">
        <legend class="font-medium">{{ t('approvals.fleet.budget.requeueTitle') }}</legend>
        <p v-if="candidates.length === 0" class="text-muted-foreground">{{ t('approvals.fleet.budget.noCandidates') }}</p>
        <label v-for="candidate in candidates" :key="candidate.jobId" class="flex items-center gap-2">
          <input
            type="checkbox"
            class="accent-primary"
            :checked="selected.includes(candidate.jobId)"
            :data-testid="`approval-request-candidate-${candidate.jobId}`"
            @change="toggle(candidate.jobId)"
          >
          <span>{{ candidate.feature }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ candidate.jobId.slice(0, 8) }}</span>
        </label>
        <p v-if="truncated" class="text-xs text-muted-foreground" data-testid="approval-request-budget-truncated">
          {{ t('approvals.fleet.budget.truncated') }}
        </p>
      </fieldset>

      <div class="max-w-xs space-y-1">
        <Label :for="amountId">{{ t('approvals.fleet.budget.amount') }}</Label>
        <Input :id="amountId" v-model="amount" inputmode="decimal" :disabled="busy" data-testid="approval-request-budget-amount" />
        <p v-if="amountError" class="text-xs text-status-rejected" data-testid="approval-request-budget-amount-error">{{ amountError }}</p>
        <p v-else class="text-xs text-muted-foreground">{{ t('approvals.fleet.budget.amountHint', { spent: formatUsd(spent) }) }}</p>
      </div>

      <div class="space-y-1">
        <Label :for="commentId">{{ t('approvals.fleet.budget.comment') }}</Label>
        <Textarea :id="commentId" v-model="comment" rows="2" :disabled="busy" data-testid="approval-request-budget-comment" />
        <p v-if="commentError" class="text-xs text-status-rejected" data-testid="approval-request-budget-comment-error">{{ commentError }}</p>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button :disabled="busy" data-testid="approval-request-budget-raise" @click="raise()">
          {{ busy ? t('approvals.fleet.budget.submitting') : t('approvals.fleet.budget.raise') }}
        </Button>
        <Button variant="outline" :disabled="busy" data-testid="approval-request-budget-keep" @click="keep()">
          {{ t('approvals.fleet.budget.keep') }}
        </Button>
      </div>
    </template>
    <p v-else-if="pending && !canDecide" class="text-muted-foreground" data-testid="approval-request-budget-readonly">
      {{ t('approvals.fleet.budget.readOnly') }}
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-004: one `fleet.budget.override` stop, decided through the engine.
 *
 * A raise needs a limit above the spend frozen at the stop and names the cancelled jobs to put back
 * in the queue (all of them ticked, as the fleet panel did); keeping the policy paused is a bare
 * rejection. Both carry the decider's comment, validated by the engine's own rules: the amount by
 * `buildBudgetRaiseSchema`, the comment by `buildCommentSchema`.
 */
import { computed, ref, watch } from 'vue'
import { budgetAskOf, budgetKeepBody, budgetRaiseBody, buildBudgetRaiseSchema, requeueCandidatesOf } from '~/lib/approval-request-fleet'
import { buildCommentSchema } from '~/lib/approval-requests'
import type { ApprovalRequestDetail, DecideRequestBody } from '~/lib/approval-requests'
import { scopeText } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'

const props = defineProps<{
  request: ApprovalRequestDetail
  canDecide: boolean
  busy: boolean
}>()

const emit = defineEmits<{ (event: 'decide', body: DecideRequestBody): void }>()

const { t } = useI18n()

const ask = computed(() => budgetAskOf(props.request))
/** A malformed payload leaves the spend unknown: any valid amount passes here and the server decides. */
const spent = computed(() => ask.value?.spentUsd ?? '0')
const pending = computed(() => props.request.status === 'pending')
const offer = computed(() => requeueCandidatesOf(props.request))
const candidates = computed(() => offer.value.candidates)
const truncated = computed(() => offer.value.truncated)

const amount = ref('')
const comment = ref('')
const amountError = ref('')
const commentError = ref('')
/** A4: every offered candidate is ticked until the decider unticks one. */
const selected = ref<readonly string[]>(candidates.value.map((candidate) => candidate.jobId))

/**
 * A4 on a refreshed detail: the list can change under the decider (a poll, or the reload after a
 * refused decide). A candidate the engine newly offers starts ticked, one it no longer offers is
 * forgotten so it can never be submitted, and an id the decider unticked stays unticked — a tick is
 * a decision about that job, not a default re-applied on every fetch.
 */
watch(candidates, (next, previous) => {
  const before = new Set((previous ?? []).map((candidate) => candidate.jobId))
  selected.value = next
    .map((candidate) => candidate.jobId)
    .filter((jobId) => selected.value.includes(jobId) || !before.has(jobId))
})

/** SSR-safe unique ids, so each label binds to this panel's own field. */
const amountId = useId()
const commentId = useId()

/** The raise form's rules, read at click time so the frozen spend is the one on screen (D243). */
const raiseSchema = computed(() => buildBudgetRaiseSchema(t, spent.value))

function toggle(jobId: string): void {
  selected.value = selected.value.includes(jobId)
    ? selected.value.filter((id) => id !== jobId)
    : [...selected.value, jobId]
}

function raise(): void {
  const result = raiseSchema.value.safeParse({ amount: amount.value, comment: comment.value })
  if (!result.success) {
    amountError.value = result.error.flatten().fieldErrors.amount?.[0] ?? ''
    commentError.value = result.error.flatten().fieldErrors.comment?.[0] ?? ''
    return
  }
  amountError.value = ''
  commentError.value = ''
  emit('decide', budgetRaiseBody({
    amount: result.data.amount,
    requeueJobIds: selected.value,
    comment: result.data.comment,
  }))
}

/** Keeping the policy paused raises nothing: only the comment has to be acceptable. */
function keep(): void {
  const result = buildCommentSchema(t).safeParse({ comment: comment.value })
  if (!result.success) {
    commentError.value = result.error.issues[0]?.message ?? ''
    return
  }
  commentError.value = ''
  emit('decide', budgetKeepBody(result.data.comment))
}
</script>
