<template>
  <div class="space-y-4 text-sm" data-testid="fleet-approval-budget-panel">
    <p v-if="payload" data-testid="fleet-approval-budget-summary">
      {{ t('fleet.approvals.budget.summary', { spent: formatUsd(payload.spentUsd), amount: formatUsd(payload.amountUsd), window: t(`fleet.budgets.window.${payload.windowKind}`) }) }}
    </p>

    <template v-if="canDecide">
      <div class="max-w-xs space-y-1">
        <Label for="fleet-approval-amount">{{ t('fleet.approvals.budget.amount') }}</Label>
        <Input id="fleet-approval-amount" v-model="amount" inputmode="decimal" data-testid="fleet-approval-amount" />
        <p v-if="amountMessage" class="text-xs text-destructive" data-testid="fleet-approval-amount-error">{{ amountMessage }}</p>
        <p v-else class="text-xs text-muted-foreground">{{ t('fleet.approvals.budget.amountHint', { spent: formatUsd(spent) }) }}</p>
      </div>

      <fieldset class="space-y-1">
        <legend class="font-medium">{{ t('fleet.approvals.budget.requeueTitle') }}</legend>
        <p v-if="candidates.length === 0" class="text-muted-foreground">{{ t('fleet.approvals.budget.noCandidates') }}</p>
        <label v-for="c in candidates" :key="c.jobId" class="flex items-center gap-2">
          <input
            type="checkbox"
            :checked="selected.includes(c.jobId)"
            :data-testid="`fleet-approval-candidate-${c.jobId}`"
            @change="toggle(c.jobId)"
          >
          <NuxtLink v-if="c.href" :to="c.href ?? ''" class="text-primary underline-offset-4 hover:underline">{{ c.feature }}</NuxtLink>
          <span v-else>{{ c.feature }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ c.jobId.slice(0, 8) }}</span>
        </label>
        <p v-if="approval.requeueCandidatesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-approval-candidates-truncated">
          {{ t('fleet.approvals.budget.truncated') }}
        </p>
      </fieldset>

      <div class="space-y-1">
        <Label for="fleet-approval-comment">{{ t('fleet.approvals.budget.comment') }}</Label>
        <Textarea id="fleet-approval-comment" v-model="comment" rows="2" data-testid="fleet-approval-comment" />
        <p v-if="commentInvalid" class="text-xs text-destructive" data-testid="fleet-approval-comment-error">{{ fieldErrors.comment?.[0] }}</p>
      </div>

      <div class="flex flex-wrap gap-2">
        <Button :disabled="busy" data-testid="fleet-approval-raise" @click="raise()">
          {{ busy ? t('fleet.approvals.budget.submitting') : t('fleet.approvals.budget.raise') }}
        </Button>
        <Button variant="outline" :disabled="busy" data-testid="fleet-approval-keep" @click="keep()">
          {{ t('fleet.approvals.budget.keep') }}
        </Button>
      </div>
    </template>
    <p v-else class="text-muted-foreground" data-testid="fleet-approval-readonly">{{ t('fleet.approvals.readOnly') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { budgetPayload, buildRaiseSchema, commentTooLong, toKeepPausedBody, toRaiseBody } from '~/lib/fleet-approvals'
import { formatUsd } from '~/lib/fleet-jobs'
import type { DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

// Mounted per `${id}:${status}` by FleetApprovalInbox (D242): the form state below is initialised once.
const props = defineProps<{
  approval: FleetApprovalDto
  canDecide: boolean
  busy: boolean
  jobLink: (projectId: string, jobId: string) => string | null
}>()

const emit = defineEmits<{ (e: 'decide', body: DecideApprovalBody): void }>()

const { t } = useI18n()

const payload = computed(() => budgetPayload(props.approval))
/** A malformed payload leaves the spend unknown: any valid amount passes here and the server decides. */
const spent = computed(() => payload.value?.spentUsd ?? '0')
/** `href` precomputed: `:to` must be a string, and v-if does not narrow a call expression. */
const candidates = computed(() =>
  (props.approval.requeueCandidates ?? []).map((c) => ({ ...c, href: props.jobLink(c.projectId, c.jobId) })))

const amount = ref('')
const comment = ref('')
/** A4: every candidate ticked by default. */
const selected = ref<readonly string[]>((props.approval.requeueCandidates ?? []).map((c) => c.jobId))
const attempted = ref(false)

// D243: schema-backed validation (.nax/rules/web.md); built once, the panel is remounted per approval and status.
const schema = buildRaiseSchema(t, spent.value)
const fieldErrors = computed(() => {
  const result = schema.safeParse({ amount: amount.value, comment: comment.value })
  return result.success ? {} : result.error.flatten().fieldErrors
})
/** Shown after the first Raise attempt; Keep paused never needs an amount. */
const amountMessage = computed(() => (attempted.value ? (fieldErrors.value.amount?.[0] ?? '') : ''))
const commentInvalid = computed(() => commentTooLong(comment.value))

function toggle(jobId: string): void {
  selected.value = selected.value.includes(jobId) ? selected.value.filter((id) => id !== jobId) : [...selected.value, jobId]
}

function raise(): void {
  attempted.value = true
  if (fieldErrors.value.amount || fieldErrors.value.comment) return
  emit('decide', toRaiseBody({ amount: amount.value, selected: selected.value, comment: comment.value }))
}

function keep(): void {
  if (commentInvalid.value) return
  emit('decide', toKeepPausedBody(comment.value))
}
</script>
