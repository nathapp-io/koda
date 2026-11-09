<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '~/composables/useApi'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { useProjectMemberNames } from '~/composables/useProjectMemberNames'
import { flowStateKey } from '~/lib/fleet-flows'
import { formatUsd } from '~/lib/fleet-jobs'
import type { FleetFlowDto, FleetFlowOverviewDto } from '~/lib/fleet-flows'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const flowId = route.params.id as string
const { t } = useI18n()
const flows = useFleetFlows(slug)
const people = useProjectMemberNames(slug)
const flow = ref<FleetFlowDto | null>(null)
const overview = ref<FleetFlowOverviewDto | null>(null)
const pending = ref(true)
const failure = ref<'notFound' | 'loadFailed' | null>(null)

const stateLabel = computed(() => {
  const current = flow.value
  if (!current) return ''
  const key = flowStateKey(current.state)
  return key ? t(key) : current.state
})
const approverName = computed(() => {
  const id = flow.value?.approval?.approverId
  return id ? people.nameOf(id) ?? id : ''
})
const unknownCostText = computed(() => {
  const count = overview.value?.unknownCostCount ?? 0
  return count > 0 ? t('fleet.flows.detail.unknownCost', { count }) : ''
})

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 404 || error.code === 40004)
}

async function load(): Promise<void> {
  pending.value = true
  failure.value = null
  const [flowResult, overviewResult] = await Promise.allSettled([flows.get(flowId), flows.overview(flowId)])
  if (flowResult.status === 'rejected') {
    failure.value = isNotFound(flowResult.reason) ? 'notFound' : 'loadFailed'
    flow.value = null
    overview.value = null
  }
  else {
    flow.value = flowResult.value
    overview.value = overviewResult.status === 'fulfilled' ? overviewResult.value : null
  }
  pending.value = false
}

onMounted(() => {
  void load()
  // Member names are cosmetic; an unavailable/departed member falls back to their id.
  void people.load().catch(() => undefined)
})
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="pending" />
    <section v-else-if="failure" role="alert" class="rounded-md border border-border p-4 text-sm">
      {{ t(`fleet.flows.detail.${failure}`) }}
    </section>
    <template v-else-if="flow">
      <PageHeader :title="t('fleet.flows.detail.title')" :subtitle="flow.id">
        <template #actions>
          <span data-testid="fleet-flow-state" class="rounded-md border border-border px-2 py-1 text-sm">{{ stateLabel }}</span>
        </template>
      </PageHeader>

      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.flows.detail.overview') }}</h2>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.entry') }}</dt><dd>{{ t(`fleet.flows.detail.entryValue.${flow.entry}`) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.branch') }}</dt><dd class="break-all">{{ flow.branch }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.reviewer') }}</dt><dd>{{ flow.roles.reviewer }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.supervisor') }}</dt><dd>{{ flow.roles.supervisor }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.createdAt') }}</dt><dd>{{ flow.createdAt }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.spend') }}</dt><dd>{{ formatUsd(flow.spentUsd) }} / {{ formatUsd(flow.costCapUsd) }}</dd></div>
        </dl>
        <p v-if="unknownCostText" data-testid="fleet-flow-unknown-cost" class="text-sm text-muted-foreground">{{ unknownCostText }}</p>
      </section>

      <section v-if="flow.approval" class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.flows.detail.approval') }}</h2>
        <p v-if="flow.state === 'PENDING' && flow.approval.approvalRequestId" class="text-sm">
          {{ t('fleet.flows.detail.pendingApproval') }}
          <NuxtLink class="underline" :to="`/${slug}/approvals`">{{ t('fleet.flows.detail.openApprovals') }}</NuxtLink>
        </p>
        <dl v-else class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.approvalMode') }}</dt><dd>{{ t(`fleet.flows.detail.approvalModeValue.${flow.approval.mode}`) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.flows.detail.approver') }}</dt><dd>{{ approverName }}</dd></div>
          <div v-if="flow.approval.approvedAt"><dt class="text-muted-foreground">{{ t('fleet.flows.detail.approvedAt') }}</dt><dd>{{ flow.approval.approvedAt }}</dd></div>
        </dl>
      </section>

      <section v-if="flow.state === 'STOPPED'" class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.flows.detail.stop') }}</h2>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div v-if="flow.stopReason"><dt class="text-muted-foreground">{{ t('fleet.flows.detail.stopReason') }}</dt><dd>{{ flow.stopReason }}</dd></div>
          <div v-if="flow.stopDetail"><dt class="text-muted-foreground">{{ t('fleet.flows.detail.stopDetail') }}</dt><dd>{{ flow.stopDetail }}</dd></div>
        </dl>
        <NuxtLink v-if="overview?.ticketRef" class="text-sm underline" :to="`/${slug}/tickets/${overview.ticketRef}`">{{ t('fleet.flows.detail.ticket', { ref: overview.ticketRef }) }}</NuxtLink>
      </section>
    </template>
  </div>
</template>
