<template>
  <div class="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="approval-request-outcome">
    <p data-testid="approval-request-outcome-status">
      <span class="font-medium">{{ t(`approvals.inbox.status.${request.status}`) }}</span>
      <template v-if="resolvedByLabel !== null"> · {{ resolvedByLabel }}</template>
    </p>
    <p
      v-if="delivery !== null"
      :data-delivery="delivery.state"
      :class="delivery.state === 'failed' ? 'text-status-rejected' : 'text-muted-foreground'"
      data-testid="approval-request-outcome-delivery"
    >
      {{ deliveryText }}
    </p>
    <div v-if="results !== null" class="space-y-1" data-testid="approval-request-outcome-requeue">
      <p class="font-medium">{{ t('approvals.fleet.requeue.title') }}</p>
      <p v-if="results.length === 0" class="text-muted-foreground" data-testid="approval-request-requeue-none">
        {{ t('approvals.fleet.requeue.none') }}
      </p>
      <ul v-else class="space-y-1">
        <li
          v-for="result in results"
          :key="result.jobId"
          class="flex items-center gap-2"
          :data-testid="`approval-request-requeue-${result.jobId}`"
          :data-ok="String(result.ok)"
        >
          <span class="font-mono text-xs">{{ result.jobId }}</span>
          <span :class="result.ok ? '' : 'text-status-rejected'">
            {{ result.ok ? t('approvals.fleet.requeue.ok') : t(`approvals.fleet.requeueFailure.${result.reason ?? 'unknown'}`) }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-004: what became of a settled fleet request, in the engine inbox.
 *
 * Three things, each from the request's own details: who settled it, whether the runner delivered a
 * bash answer to nax, and which of the re-queued jobs the raise could not put back. The raised amount
 * is deliberately absent — the re-queue results are what a decider needs to see.
 */
import { computed } from 'vue'
import { requestDelivery, requestRequeueResults, requestResolvedBy } from '~/lib/approval-request-fleet'
import type { ApprovalRequestDetail } from '~/lib/approval-requests'
import { codeLabel } from '~/lib/fleet-i18n'

const props = defineProps<{ request: ApprovalRequestDetail }>()

const { t, te } = useI18n()

const resolvedBy = computed(() => requestResolvedBy(props.request))
const resolvedByLabel = computed(() =>
  (resolvedBy.value === null ? null : codeLabel(t, te, 'approvals.fleet.resolvedBy', resolvedBy.value)))
const delivery = computed(() => requestDelivery(props.request))
const deliveryText = computed(() => {
  const view = delivery.value
  if (view === null) return ''
  return view.state === 'failed'
    ? t('approvals.fleet.delivery.failed', { detail: view.detail ?? '-' })
    : t(`approvals.fleet.delivery.${view.state}`)
})
const results = computed(() => requestRequeueResults(props.request))
</script>
