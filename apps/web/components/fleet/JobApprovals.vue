<template>
  <section class="space-y-3" data-testid="fleet-job-approvals">
    <h2 class="text-lg font-semibold">{{ t('fleet.jobs.approvalsSection.title') }}</h2>
    <p v-if="rows.length === 0" class="text-sm text-muted-foreground" data-testid="fleet-job-approvals-empty">{{ t('fleet.jobs.approvalsSection.empty') }}</p>
    <ul v-else class="divide-y divide-border rounded-md border border-border">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
        :data-testid="`fleet-job-approval-${row.id}`"
        :data-status="row.status"
      >
        <span class="min-w-0 flex-1 break-all font-mono text-xs">{{ row.preview }}</span>
        <Badge :variant="row.status === 'pending' ? 'default' : 'secondary'">{{ label('approvals.inbox.status', row.status) }}</Badge>
        <span v-if="row.outcome" class="text-xs text-muted-foreground">{{ row.outcome }}</span>
        <span v-if="row.left !== null" class="font-mono text-xs text-muted-foreground" data-testid="fleet-job-approval-countdown">{{ countdownText(row.left) }}</span>
        <span class="text-xs text-muted-foreground"><FleetAge :iso="row.createdAt" :now="now" mode="ago" /></span>
        <NuxtLink :to="row.href" class="text-xs text-primary underline-offset-4 hover:underline" :data-testid="`fleet-job-approval-open-${row.id}`">
          {{ t('fleet.jobs.approvalsSection.open') }}
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { JobApprovalRow } from '~/composables/useApprovalInbox'
import { bashAskOf, requestResolvedBy } from '~/lib/approval-request-fleet'
import { inboxHref, requestKeyLabel } from '~/lib/approval-requests'
import type { ApprovalRequestDetail } from '~/lib/approval-requests'
import { commandPreview, countdownText, secondsLeft } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'

/**
 * P3b US-007: the job page's approvals, read from the approval engine.
 *
 * D297: read-only; decisions are made in the inbox (one place for 409 and expiry handling). A row is a
 * listed request plus its detail when the page could fetch it: the detail is what turns a bash ask into
 * a command preview, and a row without one falls back to its own permission key — never a translated
 * label, because a request the page could not read must not look like one it understood.
 */
const props = defineProps<{ slug: string; approvals: JobApprovalRow[]; now: Date }>()

const { t, te } = useI18n()
const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)

/** A bash ask's one-line command; anything else reads as the key the request froze. */
function previewOf(row: JobApprovalRow): string {
  if (row.detail === null) return row.request.permissionKey
  const ask = bashAskOf(row.detail)
  return ask?.payload ? commandPreview(ask.payload) : requestKeyLabel(t, te, row.request.permissionKey)
}

/** How the request was settled: its last decision, else the engine's own resolution code. */
function outcomeOf(detail: ApprovalRequestDetail): string | null {
  const decided = detail.decisions[detail.decisions.length - 1]
  if (decided !== undefined) return label('fleet.approvals.decision', decided.decision)
  const resolvedBy = requestResolvedBy(detail)
  return resolvedBy === null ? null : label('fleet.approvals.resolvedBy', resolvedBy)
}

const rows = computed(() => props.approvals.map((row) => ({
  id: row.request.id,
  status: row.request.status,
  createdAt: row.request.createdAt,
  preview: previewOf(row),
  outcome: row.detail === null ? null : outcomeOf(row.detail),
  left: row.request.status === 'pending' ? secondsLeft(row.request.expiresAt, props.now) : null,
  href: inboxHref(props.slug, row.request.id),
})))
</script>
