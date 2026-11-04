<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { useFleetRulings } from '~/composables/useFleetRulings'
import { codeLabel } from '~/lib/fleet-i18n'
import { draftRunPrNumber } from '~/lib/fleet-rulings'
import type { FleetJobDto, FleetPrRulingDto } from '~/lib/fleet-types'
import FleetJobRulingForm from '~/components/fleet/FleetJobRulingForm.vue'

const props = defineProps<{ slug: string; job: FleetJobDto }>()
const { t, te } = useI18n()
const toast = useAppToast()
const api = useFleetRulings(props.slug)
const jobs = useFleetJobs(props.slug)
const { permissions } = useProjectPermissions(props.slug)
const prNumber = computed(() => draftRunPrNumber(props.job))
const canRule = computed(() => permissions.value.has('fleet.job.rule'))
const canDispatch = computed(() => permissions.value.has('fleet.job.dispatch'))
const rulings = ref<FleetPrRulingDto[]>([])
const loading = ref(true)
const failed = ref(false)
const finishing = ref(false)
let requestId = 0
const latest = computed(() => {
  const byItem = new Map<string, FleetPrRulingDto>()
  // GET is newest first, including every state; do not filter out skipped/applied/replaced.
  for (const ruling of rulings.value) if (!byItem.has(ruling.itemId)) byItem.set(ruling.itemId, ruling)
  return byItem
})
async function load(): Promise<void> {
  const request = ++requestId
  const id = props.job.id
  loading.value = true
  try {
    const rows = await api.list(id)
    if (request !== requestId) return
    rulings.value = rows
    failed.value = false
  }
  catch (err: unknown) {
    if (request !== requestId) return
    failed.value = true
    toast.error(extractApiError(err))
  }
  finally {
    if (request === requestId) loading.value = false
  }
}
// The page replaces the DTO on live job/approval events; reread settlement and approved rulings.
watch(() => props.job, () => {
  if (prNumber.value !== null) void load()
}, { immediate: true })

async function rule(itemId: string, text: string): Promise<void> {
  if (!canRule.value || prNumber.value === null) return
  try {
    const result = await api.create(props.job.id, { itemId, text })
    if ('permissionKey' in result) {
      if (result.permissionKey === 'fleet.job.rule' && result.status === 'pending') {
        toast.success(t('fleet.rulings.pendingApproval'))
      }
      else toast.error(t('fleet.rulings.unexpectedApproval'))
      return
    }
    toast.success(t('fleet.rulings.created'))
    await load()
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}
async function finish(): Promise<void> {
  if (finishing.value || !canDispatch.value || prNumber.value === null) return
  finishing.value = true
  try {
    const result = await jobs.dispatch({ command: 'FIX', repoId: props.job.repoId, prNumber: prNumber.value, maxCostUsd: Number(props.job.maxCostUsd) })
    await navigateTo(`/${props.slug}/fleet/jobs/${result.job.id}`)
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
  finally {
    finishing.value = false
  }
}
</script>

<template>
  <section v-if="prNumber !== null" class="space-y-3 rounded-md border border-border p-4 text-sm" data-testid="fleet-job-open-items">
    <h2 class="font-medium">{{ t('fleet.rulings.title') }}</h2>
    <LoadingState v-if="loading" />
    <ErrorState v-if="failed" @retry="load()" />
    <div class="overflow-x-auto">
      <Table>
        <TableHeader><TableRow>
          <TableHead>{{ t('fleet.rulings.item') }}</TableHead>
          <TableHead>{{ t('fleet.rulings.latest') }}</TableHead>
          <TableHead v-if="canRule">{{ t('fleet.rulings.rule') }}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          <TableRow v-for="item in job.workflow?.openItems ?? []" :key="item.id" data-testid="open-item">
            <TableCell>
              <span>{{ item.id }} {{ item.kind }} {{ item.issue }} {{ item.file }}<template v-if="item.file && item.line != null">:{{ item.line }}</template></span>
            </TableCell>
            <TableCell>
              <template v-if="latest.get(item.id)">
                <p>{{ codeLabel(t, te, 'fleet.rulings.disposition', latest.get(item.id)!.disposition) }}</p>
                <p class="whitespace-pre-wrap break-words">{{ latest.get(item.id)!.text }}</p>
                <p>{{ latest.get(item.id)!.actorType }}: {{ latest.get(item.id)!.actorId }}</p>
                <p>{{ codeLabel(t, te, 'fleet.rulings.state', latest.get(item.id)!.state) }}</p>
                <p v-if="latest.get(item.id)!.skipReason">{{ codeLabel(t, te, 'fleet.rulings.skipReason', latest.get(item.id)!.skipReason!) }}</p>
              </template>
              <span v-else>{{ t('fleet.rulings.none') }}</span>
            </TableCell>
            <TableCell v-if="canRule">
              <FleetJobRulingForm v-if="!loading && !failed && latest.get(item.id)?.state !== 'applied'" :item-id="item.id" :submit="(text) => rule(item.id, text)" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
    <Button v-if="canDispatch" :disabled="finishing" data-testid="fleet-job-finish" @click="finish()">{{ t('fleet.rulings.finish') }}</Button>
  </section>
</template>
