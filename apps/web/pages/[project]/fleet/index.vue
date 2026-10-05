<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { createDebouncer } from '~/lib/debounce'
import { codeLabel } from '~/lib/fleet-i18n'
import { canWorkOnFleet, formatUsd } from '~/lib/fleet-jobs'
import { FLEET_JOB_STATES } from '~/lib/project-event-stream'
import { runningFirstJobs } from '~/lib/fleet-jobs'
import FleetJobStateBadge from '~/components/fleet/FleetJobStateBadge.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t, te } = useI18n()
const toast = useAppToast()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const { data: viewer } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewer.value))

/** Radix Select items cannot have an empty value, so "no filter" is a sentinel. */
const ALL = '__all__'
const filters = reactive({ state: ALL, repoId: ALL, runnerId: ALL, requestedById: ALL })
const page = ref(1)
const pending = ref(true)
const loadFailed = ref(false)
let latestReloadId = 0

const pick = (value: string): string | undefined => (value === ALL ? undefined : value)

async function reload(): Promise<void> {
  const reloadId = ++latestReloadId
  try {
    const accepted = await jobsApi.load({
      state: pick(filters.state),
      repoId: pick(filters.repoId),
      runnerId: pick(filters.runnerId),
      requestedById: pick(filters.requestedById),
      page: page.value,
    })
    if (!accepted || reloadId !== latestReloadId) return
    loadFailed.value = false
  }
  catch (err: unknown) {
    if (reloadId !== latestReloadId) return
    loadFailed.value = jobsApi.jobs.value.length === 0
    toast.error(extractApiError(err))
  }
  finally {
    if (reloadId === latestReloadId) pending.value = false
  }
}

onMounted(() => {
  void reload()
  // Names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})

watch(filters, () => {
  page.value = 1
  void reload()
})

function goTo(next: number): void {
  page.value = next
  void reload()
}

// Live: any fleet job notice of this project refreshes the visible page, debounced (S1 spec §1).
const banner = ref<{ refresh: () => Promise<void> } | null>(null)
const liveReload = createDebouncer(() => { void reload(); void banner.value?.refresh() }, 300)
onBeforeUnmount(() => liveReload.cancel())
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onFleetApproval: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})

const stateLabel = (state: string): string => codeLabel(t, te, 'fleet.state', state)

// Slice 4: the state filter is a single-select chip row (the API takes exactly one state); the
// name filters stay selects. Sorting keeps running jobs on top within the loaded page.
const stateChips = [{ value: ALL, label: t('fleet.jobs.filters.allStates') }, ...FLEET_JOB_STATES.map((state) => ({ value: state, label: stateLabel(state) }))]

const sortedJobs = computed(() => runningFirstJobs(jobsApi.jobs.value))
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.jobs.title')" :subtitle="t('fleet.jobs.subtitle')">
      <template #actions>
        <Button variant="outline" data-testid="fleet-approvals-link" @click="navigateTo(`/${slug}/fleet/approvals`)">
          {{ t('fleet.jobs.approvals') }}
        </Button>
        <Button variant="outline" data-testid="fleet-schedules-link" @click="navigateTo(`/${slug}/fleet/schedules`)">
          {{ t('fleet.jobs.schedules') }}
        </Button>
        <Button variant="outline" data-testid="fleet-budgets-link" @click="navigateTo(`/${slug}/fleet/budgets`)">
          {{ t('fleet.jobs.budgets') }}
        </Button>
        <Button :disabled="!canWork" :title="canWork ? undefined : t('fleet.jobs.dispatchNoPermission')" data-testid="fleet-dispatch-button" @click="navigateTo(`/${slug}/fleet/dispatch`)">
          {{ t('fleet.jobs.dispatch') }}
        </Button>
      </template>
    </PageHeader>

    <FleetBudgetBanner ref="banner" :slug="slug" :repo-name="options.repoName" />

    <FilterBar columns="3">
      <Select v-model="filters.repoId">
        <SelectTrigger data-testid="fleet-filter-repo"><SelectValue :placeholder="t('fleet.jobs.filters.repo')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRepos') }}</SelectItem>
          <SelectItem v-for="repo in options.repos.value" :key="repo.id" :value="repo.id">{{ repo.owner }}/{{ repo.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="filters.runnerId">
        <SelectTrigger data-testid="fleet-filter-runner"><SelectValue :placeholder="t('fleet.jobs.filters.runner')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRunners') }}</SelectItem>
          <SelectItem v-for="runner in options.runners.value" :key="runner.id" :value="runner.id">{{ runner.name }}</SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="filters.requestedById">
        <SelectTrigger data-testid="fleet-filter-requester"><SelectValue :placeholder="t('fleet.jobs.filters.requester')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ALL">{{ t('fleet.jobs.filters.allRequesters') }}</SelectItem>
          <SelectItem v-for="member in people.members.value" :key="member.userId" :value="member.userId">{{ member.name || member.email }}</SelectItem>
        </SelectContent>
      </Select>
    </FilterBar>

    <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('fleet.jobs.filters.state')" data-testid="fleet-filter-state">
      <button
        v-for="chip in stateChips"
        :key="chip.value"
        type="button"
        :aria-pressed="filters.state === chip.value"
        :data-testid="`fleet-filter-chip-${chip.value}`"
        :class="['rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', filters.state === chip.value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground']"
        @click="filters.state = chip.value"
      >
        {{ chip.label }}
      </button>
    </div>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="reload()" />
    <EmptyState v-else-if="jobsApi.jobs.value.length === 0" :message="t('fleet.jobs.empty')" />
    <template v-else>
      <div class="overflow-x-auto">
        <Table data-testid="fleet-jobs-table">
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('fleet.jobs.table.feature') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.command') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.repo') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.runner') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.state') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.cost') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.requester') }}</TableHead>
              <TableHead>{{ t('fleet.jobs.table.queued') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="job in sortedJobs" :key="job.id" :data-testid="`fleet-job-row-${job.id}`">
              <TableCell>
                <NuxtLink :to="`/${slug}/fleet/jobs/${job.id}`" class="font-medium text-primary underline-offset-4 hover:underline">{{ job.feature }}</NuxtLink>
              </TableCell>
              <TableCell>{{ job.command }}</TableCell>
              <TableCell>{{ options.repoName(job.repoId) }}</TableCell>
              <TableCell>{{ options.runnerName(job.runnerId) ?? '-' }}</TableCell>
              <TableCell>
                <div class="flex flex-wrap items-center gap-2">
                  <FleetJobStateBadge :state="job.state" />
                  <Badge v-if="job.pendingApprovals > 0" variant="default" :data-testid="`fleet-job-needs-approval-${job.id}`">{{ t('fleet.jobs.needsApproval', { count: job.pendingApprovals }) }}</Badge>
                </div>
              </TableCell>
              <TableCell>{{ formatUsd(job.costSpentUsd) }}</TableCell>
              <TableCell>{{ people.nameOf(job.requestedById) ?? t('fleet.jobs.unknownMember') }}</TableCell>
              <TableCell>{{ new Date(job.queuedAt).toLocaleString() }}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>{{ t('fleet.jobs.total', { total: jobsApi.total.value }) }}</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="page <= 1" @click="goTo(page - 1)">{{ t('fleet.jobs.previous') }}</Button>
          <Button variant="outline" size="sm" :disabled="!jobsApi.hasNext.value" @click="goTo(page + 1)">{{ t('fleet.jobs.next') }}</Button>
        </div>
      </div>
    </template>
  </div>
</template>
