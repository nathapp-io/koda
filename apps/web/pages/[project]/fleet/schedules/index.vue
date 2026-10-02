<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { isForbidden } from '~/composables/useFleetBudgetPage'
import { useFleetScheduleActions } from '~/composables/useFleetScheduleActions'
import { useFleetSchedules } from '~/composables/useFleetSchedules'
import { createDebouncer } from '~/lib/debounce'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { ScheduleViewer } from '~/lib/fleet-schedules'
import type { ScheduleDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** D222: a tick that only moves nextFireAt, skips or coalesces sends no fleet_job notice; 60 s is the ticker cadence. */
const POLL_MS = 60_000

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const auth = useAuth()
const { data: viewerRole } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const people = useProjectMemberNames(slug)
const api = useFleetSchedules(slug)

// D217: the server is the gate; this only decides which controls to draw.
const viewer = computed<ScheduleViewer>(() => ({
  userId: auth.user.value?.id ?? null,
  canWork: canWorkOnFleet(viewerRole.value),
  canManage: viewerRole.value.canManage,
}))

const loaded = ref(false)
const pending = ref(true)
const loadFailed = ref(false)
const stale = ref(false)
const forbidden = ref(false)
const editOpen = ref(false)
const editing = ref<ScheduleDto | null>(null)

/** The first load reports; a failed poll keeps the last rows and marks them stale. */
async function refresh(): Promise<void> {
  try {
    await api.load()
    loaded.value = true
    loadFailed.value = false
    stale.value = false
  }
  catch (err: unknown) {
    if (isForbidden(err)) forbidden.value = true
    else if (loaded.value) stale.value = true
    else {
      loadFailed.value = true
      toast.error(extractApiError(err))
    }
  }
  finally {
    pending.value = false
  }
}

const actions = useFleetScheduleActions(api, () => { void refresh() })

async function poll(): Promise<void> {
  await refresh()
  if (forbidden.value) polling.stop()
}

// Declared after poll, which it runs; poll only reaches `polling` when it is called.
const polling = useVisiblePolling(poll, POLL_MS)
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
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

function openCreate(): void {
  editing.value = null
  editOpen.value = true
}

function openEdit(schedule: ScheduleDto): void {
  editing.value = schedule
  editOpen.value = true
}

const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const runnerOptions = computed(() => options.runners.value.map((r) => ({ value: r.id, label: r.name })))
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.schedules.title')" :subtitle="t('fleet.schedules.subtitle')">
      <template #actions>
        <Button v-if="viewer.canWork && !forbidden" data-testid="fleet-schedule-create" @click="openCreate()">
          {{ t('fleet.schedules.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!viewer.canManage && !forbidden" class="text-sm text-muted-foreground" data-testid="fleet-schedule-readonly">{{ t('fleet.schedules.readOnly') }}</p>
    <p v-if="forbidden" class="text-sm text-muted-foreground" data-testid="fleet-schedule-forbidden">{{ t('fleet.schedules.forbidden') }}</p>
    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="refresh()" />
    <template v-else-if="!forbidden">
      <EmptyState v-if="api.schedules.value.length === 0" :message="t('fleet.schedules.empty')" />
      <FleetScheduleTable
        v-else
        :schedules="api.schedules.value"
        :slug="slug"
        :viewer="viewer"
        :repo-name="options.repoName"
        :owner-name="people.nameOf"
        :busy="actions.busy.value"
        @edit="openEdit"
        @toggle="(schedule, enabled) => actions.setEnabled(schedule, enabled)"
        @remove="(schedule) => actions.remove(schedule)"
      />
    </template>

    <FleetScheduleEditDialog
      v-if="viewer.canWork"
      :key="editing?.id ?? 'new'"
      v-model:open="editOpen"
      :slug="slug"
      :schedule="editing"
      :repo-options="repoOptions"
      :runner-options="runnerOptions"
      :profile-suggestions="options.profileOptions.value"
      :label-suggestions="options.labelOptions.value"
      @saved="api.apply"
      @failed="refresh()"
    />
  </div>
</template>
