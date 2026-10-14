<script setup lang="ts">
import { computed } from 'vue'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'
import { usd } from '~/lib/fleet-analytics-format'
import type { FleetJobDto } from '~/lib/fleet-types'
import type { ThreadHandoffJob } from '~/lib/thread-types'
import { safePrHref, workflowOutcomeKey } from '~/lib/thread-timeline'

/**
 * Fleet S5a US-004: a PLAN or RUN card in the transcript, built from the thread's handoff.
 *
 * The handoff always gives the state. When the job detail is loaded (`job`) the card adds the
 * workflow outcome, the cost, the PR and the escalation reason (C3-R3); with no detail it degrades to
 * the handoff's own state and reason, with no toast. Runner-written text is `{{ }}` only.
 */
const props = defineProps<{
  command: 'PLAN' | 'RUN'
  handoff: ThreadHandoffJob
  job: FleetJobDto | null
  slug: string
}>()
const { t, te } = useI18n()

const state = computed(() => props.job?.state ?? props.handoff.state)
const reason = computed(() => props.handoff.stateReason)
const prHref = computed(() => (props.command === 'RUN' ? safePrHref(props.job?.resultPrUrl ?? null) : null))
const outcomeKey = computed(() => {
  const outcome = props.command === 'RUN' ? props.job?.workflow?.outcome : undefined
  return outcome === undefined ? null : `fleet.jobs.workflow.outcome.${workflowOutcomeKey(outcome)}`
})
const needsYou = computed(() => props.command === 'RUN' && state.value === 'ESCALATED')
const workflowReasons = computed(() => props.job?.workflow?.reasons ?? [])
const jobHref = computed(() => `/${props.slug}/fleet/jobs/${props.handoff.jobId}`)
</script>

<template>
  <div class="rounded-md border border-border bg-card px-3 py-2 text-sm" data-testid="thread-job-card" :data-command="command">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-medium">{{ command === 'PLAN' ? t('fleet.threads.handoff.card.plan') : t('fleet.threads.handoff.card.run') }}</span>
      <FleetJobStateBadge :state="state" />
      <span v-if="job" class="text-xs text-muted-foreground">{{ usd(job.costSpentUsd) }}</span>
      <NuxtLink :to="jobHref" class="text-xs text-primary underline-offset-4 hover:underline" data-testid="thread-job-card-link">{{ t('fleet.threads.handoff.card.openJob') }}</NuxtLink>
    </div>
    <div v-if="outcomeKey && te(outcomeKey)" class="mt-1 text-xs text-muted-foreground" data-testid="thread-job-card-outcome">{{ t(outcomeKey) }}</div>
    <div v-if="reason" class="mt-1 text-xs text-muted-foreground" data-testid="thread-job-card-reason">{{ reason }}</div>
    <div v-if="needsYou" class="mt-1 text-xs text-status-rejected" data-testid="thread-job-card-needs-you">
      <span>{{ t('fleet.threads.handoff.card.needsYou') }}</span>
      <span v-if="job?.escalationReason"> {{ job.escalationReason }}</span>
    </div>
    <div v-if="workflowReasons.length > 0" class="mt-1 text-xs text-muted-foreground">
      <ul class="space-y-0.5">
        <li v-for="item in workflowReasons" :key="item">{{ item }}</li>
      </ul>
    </div>
    <a v-if="prHref" :href="prHref" target="_blank" rel="noopener noreferrer" class="mt-1 block text-xs text-primary underline-offset-4 hover:underline" data-testid="thread-job-card-pr">{{ t('fleet.threads.handoff.card.pr') }}</a>
  </div>
</template>
