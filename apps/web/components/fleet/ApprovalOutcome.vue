<template>
  <div class="space-y-2 text-sm" data-testid="fleet-approval-outcome">
    <p data-testid="fleet-approval-outcome-decision">
      <span class="font-medium">{{ label('fleet.approvals.status', approval.status) }}</span>
      <template v-if="approval.decision"> · {{ label('fleet.approvals.decision', approval.decision) }}</template>
      <template v-if="approval.resolvedBy"> · {{ label('fleet.approvals.resolvedBy', approval.resolvedBy) }}</template>
    </p>
    <p class="text-muted-foreground">
      <span v-if="approval.decidedById" data-testid="fleet-approval-outcome-by">{{ t('fleet.approvals.outcome.decidedBy', { name: deciderName }) }}</span>
      <span v-if="approval.decidedAt" class="ml-2">{{ t('fleet.approvals.outcome.decidedAt', { at: new Date(approval.decidedAt).toLocaleString() }) }}</span>
    </p>
    <p v-if="raised" data-testid="fleet-approval-outcome-raised">{{ t('fleet.approvals.outcome.raisedTo', { amount: formatUsd(raised) }) }}</p>
    <p v-if="approval.resolvedBy === 'manual_resume'" class="text-muted-foreground" data-testid="fleet-approval-outcome-manual">
      {{ t('fleet.approvals.outcome.manualResume') }}
    </p>

    <div v-if="results" class="space-y-1">
      <p class="font-medium">{{ t('fleet.approvals.outcome.requeueTitle') }}</p>
      <p v-if="results.length === 0" class="text-muted-foreground" data-testid="fleet-approval-requeue-none">{{ t('fleet.approvals.outcome.requeueNone') }}</p>
      <ul v-else class="space-y-1">
        <li
          v-for="r in results"
          :key="r.jobId"
          class="flex items-center gap-2"
          :data-testid="`fleet-approval-requeue-result-${r.jobId}`"
          :data-ok="String(r.ok)"
        >
          <NuxtLink v-if="r.href" :to="r.href ?? ''" class="font-mono text-xs text-primary underline-offset-4 hover:underline">{{ r.jobId.slice(0, 8) }}</NuxtLink>
          <span v-else class="font-mono text-xs">{{ r.jobId.slice(0, 8) }}</span>
          <span :class="r.ok ? '' : 'text-destructive'">
            {{ r.ok ? t('fleet.approvals.outcome.requeueOk') : t(`fleet.approvals.requeueFailure.${r.reason ?? 'unknown'}`) }}
          </span>
        </li>
      </ul>
    </div>

    <p v-if="approval.comment">{{ t('fleet.approvals.outcome.comment', { comment: approval.comment }) }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { requeueResults, resumedAmount } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import { formatUsd } from '~/lib/fleet-jobs'
import type { FleetApprovalDto } from '~/lib/fleet-types'

const props = defineProps<{
  approval: FleetApprovalDto
  nameOf: (userId: string) => string | null
  jobLink: (projectId: string, jobId: string) => string | null
}>()

const { t, te } = useI18n()
const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)

const raised = computed(() => resumedAmount(props.approval))
/** `href` precomputed: `:to` must be a string, and v-if does not narrow a call expression. */
const results = computed(() => requeueResults(props.approval)?.map((r) => ({ ...r, href: link(r.jobId) })) ?? null)
const deciderName = computed(() =>
  (props.approval.decidedById ? props.nameOf(props.approval.decidedById) : null) ?? t('fleet.approvals.outcome.unknownUser'))
/** Re-queued jobs live in the approval's project; a no-project approval has no project to link into. */
const link = (jobId: string): string | null => (props.approval.projectId ? props.jobLink(props.approval.projectId, jobId) : null)
</script>
