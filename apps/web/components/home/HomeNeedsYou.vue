<script setup lang="ts">
import { AlertTriangle, ClipboardList, ShieldCheck } from 'lucide-vue-next'
import { formatUsd } from '~/lib/fleet-jobs'
import { TICKET_CHIP_CLASS, TICKET_DOT_CLASS, priorityDotClass, statusDotClass } from '~/lib/ticket-chips'
import type { HomeNeedsYou } from '~/lib/home-types'

/**
 * "Needs you" — the three attention lists of the home dashboard (MASTER-PLAN §6 slice 2).
 * Rows link into the owning project; counts shown are exact totals, lists are capped by the API.
 */
const props = defineProps<{ needsYou: HomeNeedsYou; now: Date }>()

const { t } = useI18n()

const chipClass = TICKET_CHIP_CLASS

const anythingTodo = computed(
  () => props.needsYou.ticketsTotal > 0 || props.needsYou.approvalsTotal > 0 || props.needsYou.jobsTotal > 0,
)

function approvalTarget(a: HomeNeedsYou['approvals'][number]): string {
  return a.projectSlug ? `/${a.projectSlug}/fleet/approvals` : '/admin/fleet/approvals'
}
</script>

<template>
  <div v-if="anythingTodo" class="grid grid-cols-1 gap-4 lg:grid-cols-3">
    <Card class="shadow-none">
      <CardHeader class="pb-2">
        <CardTitle class="flex items-center gap-2 text-base">
          <ClipboardList class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {{ t('home.tickets.title') }}
          <span class="font-normal text-muted-foreground">{{ needsYou.ticketsTotal }}</span>
        </CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <p v-if="needsYou.tickets.length === 0" class="px-6 pb-4 text-sm text-muted-foreground">{{ t('home.tickets.empty') }}</p>
        <ul v-else class="divide-y divide-border">
          <li v-for="ticket in needsYou.tickets" :key="ticket.id">
            <NuxtLink :to="`/${ticket.projectSlug}/tickets/${ticket.ref}`" class="flex items-center gap-2 px-6 py-2.5 text-sm hover:bg-accent/40">
              <span class="font-mono text-xs text-muted-foreground">{{ ticket.ref }}</span>
              <span class="min-w-0 flex-1 truncate">{{ ticket.title }}</span>
              <span :class="chipClass">
                <span :class="[TICKET_DOT_CLASS, statusDotClass(ticket.status)]" aria-hidden="true" />{{ t(`tickets.status.${ticket.status}`) }}
              </span>
              <span :class="chipClass">
                <span :class="[TICKET_DOT_CLASS, priorityDotClass(ticket.priority)]" aria-hidden="true" />{{ t(`tickets.priority.${ticket.priority}`) }}
              </span>
            </NuxtLink>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader class="pb-2">
        <CardTitle class="flex items-center gap-2 text-base">
          <ShieldCheck class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {{ t('home.approvals.title') }}
          <span class="font-normal text-muted-foreground">{{ needsYou.approvalsTotal }}</span>
        </CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <p v-if="needsYou.approvals.length === 0" class="px-6 pb-4 text-sm text-muted-foreground">{{ t('home.approvals.empty') }}</p>
        <ul v-else class="divide-y divide-border">
          <li v-for="approval in needsYou.approvals" :key="approval.id">
            <NuxtLink :to="approvalTarget(approval)" class="flex items-center gap-2 px-6 py-2.5 text-sm hover:bg-accent/40">
              <span class="rounded-md border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium">{{ t(`fleet.approvals.type.${approval.type}`) }}</span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{{ approval.projectSlug ?? t('fleet.approvals.noProject') }}</span>
              <FleetAge class="shrink-0 text-xs text-muted-foreground" :iso="approval.requestedAt" :now="now" mode="ago" />
            </NuxtLink>
          </li>
        </ul>
      </CardContent>
    </Card>

    <Card class="shadow-none">
      <CardHeader class="pb-2">
        <CardTitle class="flex items-center gap-2 text-base">
          <AlertTriangle class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {{ t('home.jobs.title') }}
          <span class="font-normal text-muted-foreground">{{ needsYou.jobsTotal }}</span>
        </CardTitle>
      </CardHeader>
      <CardContent class="p-0">
        <p v-if="needsYou.jobs.length === 0" class="px-6 pb-4 text-sm text-muted-foreground">{{ t('home.jobs.empty') }}</p>
        <ul v-else class="divide-y divide-border">
          <li v-for="job in needsYou.jobs" :key="job.id">
            <NuxtLink :to="`/${job.projectSlug}/fleet/jobs/${job.id}`" class="flex items-center gap-2 px-6 py-2.5 text-sm hover:bg-accent/40">
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ job.feature }}</span>
              <FleetJobStateBadge :state="job.state" />
              <span
                v-if="job.pendingApprovals > 0"
                class="rounded-md border border-amber-500/50 bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium"
              >{{ t('fleet.jobs.needsApproval', { count: job.pendingApprovals }) }}</span>
              <span v-if="job.costSpentUsd !== '0'" class="shrink-0 font-mono text-xs text-muted-foreground">{{ formatUsd(job.costSpentUsd) }}</span>
            </NuxtLink>
          </li>
        </ul>
      </CardContent>
    </Card>
  </div>
  <p v-else class="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
    {{ t('home.needsYouEmpty') }}
  </p>
</template>
