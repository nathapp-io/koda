<script setup lang="ts">
import { KeyRound } from 'lucide-vue-next'
import { ApiError, extractApiError } from '~/composables/useApi'
import { FLEET_LIST_SIZE } from '~/lib/fleet-types'
import type { FleetRunner } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** S1 spec §1: the Runners page is not project-scoped, so it polls instead of using SSE. */
const POLL_MS = 15_000

const { t } = useI18n()
const toast = useAppToast()
const { runners, hasMore, pending, load, apply, update, remove } = useFleetRunners()

const adminOnly = ref(false)
const stale = ref(false)
const now = ref(new Date())
const enrollOpen = ref(false)
const editOpen = ref(false)
const editing = ref<FleetRunner | null>(null)

// ApiError.code is the envelope `ret`: a 403 arrives as ret 40003 (see pages/admin/users.vue).
function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 40003 || err.code === 403)
}

async function refresh(): Promise<void> {
  try {
    await load()
    stale.value = false
  } catch (err: unknown) {
    if (isForbidden(err)) {
      adminOnly.value = true
      polling.stop()
      return
    }
    // The first load reports; a failed poll keeps the last rows and marks them stale.
    if (runners.value.length === 0) toast.error(extractApiError(err))
    stale.value = true
  } finally {
    now.value = new Date()
  }
}

// Declared after refresh, which it runs; refresh only reaches `polling` when it is called.
const polling = useVisiblePolling(refresh, POLL_MS)

async function setEnabled(runner: FleetRunner, enabled: boolean): Promise<void> {
  try {
    await update(runner.id, { enabled })
    toast.success(t(enabled ? 'fleet.runners.toast.enabled' : 'fleet.runners.toast.disabled'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

function openEdit(runner: FleetRunner): void {
  editing.value = runner
  editOpen.value = true
}

async function confirmDelete(runner: FleetRunner): Promise<void> {
  if (!window.confirm(t('fleet.runners.deleteConfirm', { name: runner.name }))) return
  try {
    await remove(runner.id)
    toast.success(t('fleet.runners.toast.deleted'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

onMounted(() => {
  void polling.runNow()
  polling.start()
})
onBeforeUnmount(polling.stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.runners.title')" :subtitle="t('fleet.runners.subtitle')">
      <template #actions>
        <NuxtLink
          to="/admin/fleet/credentials"
          class="mr-4 self-center text-sm text-primary underline-offset-4 hover:underline"
          data-testid="fleet-runners-credentials-link"
        >{{ t('fleet.runners.actions.credentials') }}</NuxtLink>
        <Button :disabled="adminOnly" @click="enrollOpen = true">
          <KeyRound class="mr-2 h-4 w-4" />{{ t('fleet.runners.actions.enroll') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="adminOnly" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
      <LoadingState v-if="pending && runners.length === 0" />
      <EmptyState v-else-if="runners.length === 0" :message="t('fleet.runners.empty')" />
      <Table v-else>
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('fleet.runners.table.name') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.status') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.labels') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.capacity') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.capabilities') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.lastSeen') }}</TableHead>
            <TableHead>{{ t('fleet.runners.table.boot') }}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="runner in runners" :key="runner.id" :data-testid="`fleet-runner-${runner.name}`">
            <TableCell>
              <div class="font-medium">{{ runner.name }}</div>
              <div class="text-xs text-muted-foreground">{{ runner.os }}/{{ runner.arch }} · {{ t('fleet.runners.table.version') }} {{ runner.daemonVersion }}</div>
            </TableCell>
            <TableCell class="space-x-1">
              <Badge :variant="runner.online ? 'secondary' : 'outline'">{{ runner.online ? t('fleet.common.online') : t('fleet.common.offline') }}</Badge>
              <Badge v-if="!runner.enabled" variant="destructive">{{ t('fleet.common.disabled') }}</Badge>
            </TableCell>
            <TableCell>
              <div class="flex flex-wrap gap-1">
                <Badge v-for="label in runner.labels" :key="label" variant="outline">{{ label }}</Badge>
              </div>
            </TableCell>
            <TableCell>{{ runner.capacity }}</TableCell>
            <TableCell><FleetRunnerCapabilityChips :capabilities="runner.capabilities" /></TableCell>
            <TableCell><FleetAge :iso="runner.lastSeenAt" :now="now" mode="ago" /></TableCell>
            <TableCell>
              <FleetAge v-if="runner.online" :iso="runner.bootedAt" :now="now" mode="duration" />
              <span v-else class="text-muted-foreground">—</span>
            </TableCell>
            <TableCell class="space-x-1 whitespace-nowrap text-right">
              <Button size="sm" variant="outline" @click="setEnabled(runner, !runner.enabled)">
                {{ runner.enabled ? t('fleet.runners.actions.disable') : t('fleet.runners.actions.enable') }}
              </Button>
              <Button size="sm" variant="outline" @click="openEdit(runner)">{{ t('fleet.runners.actions.edit') }}</Button>
              <Button size="sm" variant="destructive" @click="confirmDelete(runner)">{{ t('fleet.runners.actions.delete') }}</Button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-if="hasMore" class="text-sm text-muted-foreground">{{ t('fleet.common.more', { n: FLEET_LIST_SIZE }) }}</p>
    </template>

    <FleetEnrollmentTokenDialog v-model:open="enrollOpen" />
    <FleetRunnerEditDialog v-if="editing" v-model:open="editOpen" :runner="editing" @saved="apply" />
  </div>
</template>
