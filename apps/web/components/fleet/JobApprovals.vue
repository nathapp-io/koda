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
        <Badge :variant="row.status === 'pending' ? 'default' : 'secondary'">{{ label('fleet.approvals.status', row.status) }}</Badge>
        <span v-if="row.detail" class="text-xs text-muted-foreground">{{ row.detail }}</span>
        <span v-if="row.left !== null" class="font-mono text-xs text-muted-foreground" data-testid="fleet-job-approval-countdown">{{ countdownText(row.left) }}</span>
        <span class="text-xs text-muted-foreground"><FleetAge :iso="row.requestedAt" :now="now" mode="ago" /></span>
        <NuxtLink :to="row.href" class="text-xs text-primary underline-offset-4 hover:underline" :data-testid="`fleet-job-approval-open-${row.id}`">
          {{ t('fleet.jobs.approvalsSection.open') }}
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { bashPayload, commandPreview, countdownText, inboxPath, secondsLeft } from '~/lib/fleet-approvals'
import { codeLabel } from '~/lib/fleet-i18n'
import type { FleetApprovalDto } from '~/lib/fleet-types'

// D297: read-only; decisions are made in the inbox (one place for 409 and expiry handling).
const props = defineProps<{ slug: string; approvals: FleetApprovalDto[]; now: Date }>()

const { t, te } = useI18n()
const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)

const rows = computed(() => props.approvals.map((a) => {
  const bash = bashPayload(a)
  return {
    id: a.id,
    status: a.status,
    requestedAt: a.requestedAt,
    preview: bash ? commandPreview(bash) : t('fleet.approvals.summary.bash'),
    detail: a.decision ? label('fleet.approvals.decision', a.decision) : (a.resolvedBy ? label('fleet.approvals.resolvedBy', a.resolvedBy) : null),
    left: a.status === 'pending' ? secondsLeft(a.expiresAt, props.now) : null,
    href: inboxPath({ kind: 'project', slug: props.slug }, a.id),
  }
}))
</script>
