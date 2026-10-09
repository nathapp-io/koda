<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ApiError, extractApiError } from '~/composables/useApi'
import { useFleetScheduleActions } from '~/composables/useFleetScheduleActions'
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import { createDebouncer } from '~/lib/debounce'
import { canWorkOnFleet, formatUsd } from '~/lib/fleet-jobs'
import { bashSummary } from '~/lib/fleet-bash-mode'
import { canChangeSchedule, formatInZone, historyRows, placementOf, scheduleStatusKey } from '~/lib/fleet-schedules'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** D222: ticks that change no job state send no notice; 60 s is the ticker cadence. */
const POLL_MS = 60_000

const route = useRoute()
const slug = route.params.project as string
const scheduleId = route.params.id as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const { data: viewerRole } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const api = useFleetSchedules(slug)
const jobsApi = useFleetJobs(slug)

const schedule = ref<ScheduleDto | null>(null)
const pending = ref(true)
const loadFailed = ref(false)
const historyPage = ref(1)
const historyFailed = ref(false)
const editOpen = ref(false)

const viewer = computed<ScheduleViewer>(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
  canManage: viewerRole.value.canManage,
}))
const canChange = computed(() => schedule.value !== null && canChangeSchedule(schedule.value, viewer.value))
const rows = computed(() => historyRows(jobsApi.jobs.value, !jobsApi.hasNext.value))

const placementText = computed((): string => {
  const s = schedule.value
  if (s === null) return '-'
  switch (placementOf(s)) {
    case 'pin': return t('fleet.schedules.detail.placementPin', { runner: options.runnerName(s.pinnedRunnerId) ?? '-' })
    case 'labels': return t('fleet.schedules.detail.placementLabels', { labels: s.selectorLabels.join(', ') })
    default: return t('fleet.schedules.form.placementMode.auto')
  }
})

/** ApiError.code is the envelope `ret`: a 404 arrives as ret 40004 (same convention as isForbidden). */
const isNotFound = (err: unknown): boolean => err instanceof ApiError && (err.code === 40004 || err.code === 404)

/**
 * `silent`: a live reload keeps the page on a transient failure, but a schedule that is gone (deleted elsewhere, or a
 * refused action found it missing) drops its controls and shows the error state (Review Focus 4). The first load reports.
 */
async function loadSchedule(silent: boolean): Promise<void> {
  try {
    const row = await api.get(scheduleId)
    if (row === null) return
    schedule.value = row
    loadFailed.value = false
  }
  catch (err: unknown) {
    if (!silent || isNotFound(err)) {
      schedule.value = null
      loadFailed.value = true
      if (!silent) toast.error(extractApiError(err))
    }
  }
  finally {
    pending.value = false
  }
}

async function loadHistory(): Promise<void> {
  try {
    await jobsApi.load({ scheduleId, page: historyPage.value })
    historyFailed.value = false
  }
  catch {
    historyFailed.value = jobsApi.jobs.value.length === 0
  }
}

async function reload(): Promise<void> {
  await Promise.all([loadSchedule(true), loadHistory()])
}

function goTo(page: number): void {
  historyPage.value = page
  void loadHistory()
}

const actions = useFleetScheduleActions(api, () => { void reload() })

async function toggle(): Promise<void> {
  const current = schedule.value
  if (current === null) return
  const saved = await actions.setEnabled(current, !current.enabled)
  if (saved) schedule.value = saved
}

async function remove(): Promise<void> {
  const current = schedule.value
  if (current === null) return
  if (await actions.remove(current)) await navigateTo(`/${slug}/fleet/schedules`)
}

const polling = useVisiblePolling(reload, POLL_MS)
const liveReload = createDebouncer(() => { void reload() }, 300)

onMounted(() => {
  // Started before any await: if the user leaves during the first load, onBeforeUnmount still stops it.
  polling.start()
  void loadSchedule(false)
  void loadHistory()
  // Names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
  void people.load().catch(() => undefined)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})

const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const runnerOptions = computed(() => options.runners.value.map((r) => ({ value: r.id, label: r.name })))
</script>

<template>
  <div class="space-y-6">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed || !schedule" @retry="loadSchedule(false)" />
    <template v-else>
      <PageHeader :title="schedule.name" :subtitle="t('fleet.schedules.cronIn', { cron: schedule.cron, zone: schedule.timezone })">
        <template #actions>
          <template v-if="canChange">
            <Button
              variant="outline"
              :disabled="actions.busy.value"
              :data-testid="schedule.enabled ? 'fleet-schedule-disable' : 'fleet-schedule-enable'"
              @click="toggle()"
            >
              {{ schedule.enabled ? t('fleet.schedules.actions.disable') : t('fleet.schedules.actions.enable') }}
            </Button>
            <Button variant="outline" data-testid="fleet-schedule-edit" @click="editOpen = true">{{ t('fleet.schedules.actions.edit') }}</Button>
            <Button variant="destructive" :disabled="actions.busy.value" data-testid="fleet-schedule-delete" @click="remove()">{{ t('fleet.schedules.actions.delete') }}</Button>
          </template>
        </template>
      </PageHeader>

      <div class="flex flex-wrap items-center gap-3">
        <Badge :variant="schedule.enabled ? 'default' : 'outline'" data-testid="fleet-schedule-status" :data-status="scheduleStatusKey(schedule)">
          {{ t(`fleet.schedules.status.${scheduleStatusKey(schedule)}`) }}
        </Badge>
      </div>

      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.schedules.detail.template') }}</h2>
        <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.repo') }}</dt><dd>{{ options.repoName(schedule.repoId) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.feature') }}</dt><dd class="break-all">{{ schedule.feature }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.ref') }}</dt><dd class="break-all">{{ schedule.ref }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.profiles') }}</dt><dd>{{ schedule.profiles.length > 0 ? schedule.profiles.join(' > ') : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.maxCost') }}</dt><dd>{{ formatUsd(schedule.maxCostUsd) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.placement') }}</dt><dd>{{ placementText }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.bash') }}</dt><dd data-testid="fleet-schedule-bash">{{ bashSummary(t, schedule.bashMode, schedule.approvalTimeoutSec) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.cron') }}</dt><dd class="font-mono">{{ schedule.cron }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.nextFire') }}</dt><dd data-testid="fleet-schedule-next-fire">{{ schedule.nextFireAt ? t('fleet.schedules.inZone', { time: formatInZone(schedule.nextFireAt, schedule.timezone), zone: schedule.timezone }) : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.lastFired') }}</dt><dd>{{ schedule.lastFiredAt ? t('fleet.schedules.inZone', { time: formatInZone(schedule.lastFiredAt, schedule.timezone), zone: schedule.timezone }) : '-' }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.progress') }}</dt><dd>{{ t('fleet.schedules.detail.progressValue', { passed: schedule.lastPassedCount, ticks: schedule.noProgressTicks, limit: schedule.noProgressLimit }) }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.owner') }}</dt><dd>{{ people.nameOf(schedule.createdById) ?? t('fleet.schedules.detail.unknownOwner') }}</dd></div>
          <div><dt class="text-muted-foreground">{{ t('fleet.schedules.detail.totalCost') }}</dt><dd data-testid="fleet-schedule-total-cost">{{ formatUsd(schedule.totalCostUsd) }}</dd></div>
        </dl>
      </section>

      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.schedules.history.title') }}</h2>
        <ErrorState v-if="historyFailed" @retry="loadHistory()" />
        <template v-else>
          <FleetScheduleHistory :slug="slug" :rows="rows" />
          <div v-if="historyPage > 1 || jobsApi.hasNext.value" class="flex justify-end gap-2">
            <Button variant="outline" size="sm" :disabled="historyPage <= 1" @click="goTo(historyPage - 1)">{{ t('fleet.schedules.history.previous') }}</Button>
            <Button variant="outline" size="sm" :disabled="!jobsApi.hasNext.value" @click="goTo(historyPage + 1)">{{ t('fleet.schedules.history.next') }}</Button>
          </div>
        </template>
      </section>

      <FleetScheduleEditDialog
        v-if="canChange"
        v-model:open="editOpen"
        :slug="slug"
        :schedule="schedule"
        :repo-options="repoOptions"
        :runner-options="runnerOptions"
        :profile-suggestions="options.profileOptions.value"
        :label-suggestions="options.labelOptions.value"
        @saved="(saved) => { schedule = saved }"
        @failed="reload()"
      />
    </template>
  </div>
</template>
