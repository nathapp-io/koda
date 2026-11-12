<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { flowStateKey, type FleetFlowPage } from '~/lib/fleet-flows'
import { formatUsd } from '~/lib/fleet-jobs'

definePageMeta({ layout: 'default' })
const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const flows = useFleetFlows(slug)
const result = ref<FleetFlowPage | null>(null)
const pending = ref(true)
const failed = ref(false)
const page = ref(1)
async function load(current: number): Promise<void> {
  pending.value = true
  try {
    result.value = await flows.list(current)
    page.value = current
    failed.value = false
  } catch (err: unknown) {
    result.value = null
    failed.value = true
    toast.error(extractApiError(err))
  } finally { pending.value = false }
}
onMounted(() => { void load(1) })
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.flows.list.title')" />
    <LoadingState v-if="pending && result === null" />
    <ErrorState v-else-if="failed" />
    <template v-else-if="result">
      <p v-if="result.records.length === 0" class="text-sm text-muted-foreground">{{ t('fleet.flows.list.empty') }}</p>
      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm"><thead><tr><th>{{ t('fleet.flows.list.state') }}</th><th>{{ t('fleet.flows.list.features') }}</th><th>{{ t('fleet.flows.list.spend') }}</th><th>{{ t('fleet.flows.list.createdAt') }}</th></tr></thead>
          <tbody><tr v-for="flow in result.records" :key="flow.id" data-testid="fleet-flow-row">
            <td><NuxtLink :to="`/${slug}/flows/${flow.id}`" class="inline-flex min-h-11 items-center sm:min-h-0">{{ flowStateKey(flow.state) ? t(flowStateKey(flow.state)!) : flow.state }}</NuxtLink></td>
            <td>{{ flow.features.map(feature => feature.feature).join(', ') }}</td>
            <td>{{ formatUsd(flow.spentUsd) }} / {{ formatUsd(flow.costCapUsd) }}</td>
            <td>{{ flow.createdAt }}</td>
          </tr></tbody>
        </table>
      </div>
      <nav class="flex gap-2" :aria-label="t('fleet.flows.list.pagination')">
        <button data-testid="flows-prev" :disabled="!result.hasPrev || pending" @click="load(page - 1)">{{ t('fleet.flows.list.previous') }}</button>
        <span>{{ result.current }}</span>
        <button data-testid="flows-next" :disabled="!result.hasNext || pending" @click="load(page + 1)">{{ t('fleet.flows.list.next') }}</button>
      </nav>
    </template>
  </div>
</template>
