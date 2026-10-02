<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgetPage } from '~/composables/useFleetBudgetPage'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { createDebouncer } from '~/lib/debounce'
import { isManagedOn, scopeName, scopeText } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/**
 * fleet_job notices fire on job state changes only: a snapshot that raises spend, a warn, or a hard
 * stop that cancels nothing sends none, so the poll is what makes a new pause visible (D178).
 */
const POLL_MS = 30_000

const route = useRoute()
const slug = route.params.project as string
const base: BudgetBase = { kind: 'project', slug }
const { t } = useI18n()
const { data: viewer } = useProjectViewerRole(slug)
const options = useFleetDispatchOptions(slug)
const {
  policies, pending, loadFailed, stale, editOpen, editing, resumeOpen, resuming,
  refresh, openCreate, openEdit, openResume, remove, onApplied,
} = useFleetBudgetPage(base)

// D176: the server is the gate; this only decides which controls to draw.
const canManage = computed(() => viewer.value.canManage)
// D175: the project's own policies (editable) and the fleet-wide ones (read-only).
const own = computed(() => policies.value.filter((p) => isManagedOn('project', p)))
const fleetWide = computed(() => policies.value.filter((p) => p.scopeType === 'global'))
const repoOptions = computed(() => options.repos.value.map((r) => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const nameOf = (p: BudgetPolicyDto): string | null =>
  scopeName(p, { project: slug, repo: options.repoName, runner: (id) => id })
const confirmText = (p: BudgetPolicyDto): string => t('fleet.budgets.deleteConfirm', { scope: scopeText(t, p, nameOf(p)) })

const polling = useVisiblePolling(refresh, POLL_MS)
const liveReload = createDebouncer(() => { void refresh() }, 300)

onMounted(() => {
  void polling.runNow()
  polling.start()
  // Repo names are cosmetic: a failure leaves ids on screen.
  void options.load().catch(() => undefined)
})
onBeforeUnmount(() => {
  polling.stop()
  liveReload.cancel()
})
useProjectEvents(slug, {
  onFleetJob: () => liveReload.trigger(),
  onResync: () => liveReload.trigger(),
})
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.budgets.title')" :subtitle="t('fleet.budgets.subtitleProject')">
      <template #actions>
        <Button v-if="canManage" data-testid="fleet-budget-create" @click="openCreate()">
          {{ t('fleet.budgets.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="!canManage" class="text-sm text-muted-foreground" data-testid="fleet-budget-readonly">{{ t('fleet.budgets.readOnly') }}</p>
    <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="refresh()" />
    <template v-else>
      <section class="space-y-2">
        <h2 class="text-sm font-medium">{{ t('fleet.budgets.sections.own') }}</h2>
        <EmptyState v-if="own.length === 0" :message="t('fleet.budgets.empty')" />
        <FleetBudgetTable
          v-else
          testid="fleet-budgets-own"
          :policies="own"
          :editable="canManage"
          :scope-name="nameOf"
          @edit="openEdit"
          @resume="openResume"
          @remove="(p) => remove(p, confirmText(p))"
        />
      </section>

      <section v-if="fleetWide.length > 0" class="space-y-2" data-testid="fleet-budgets-global-section">
        <h2 class="text-sm font-medium">{{ t('fleet.budgets.sections.global') }}</h2>
        <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.sections.globalHint') }}</p>
        <FleetBudgetTable testid="fleet-budgets-global" :policies="fleetWide" :editable="false" :scope-name="nameOf" />
      </section>
    </template>

    <FleetBudgetEditDialog
      v-if="canManage"
      v-model:open="editOpen"
      :base="base"
      :policy="editing"
      :repo-options="repoOptions"
      @saved="onApplied"
      @failed="refresh()"
    />
    <FleetBudgetResumeDialog
      v-if="canManage && resuming"
      :key="resuming.id"
      v-model:open="resumeOpen"
      :base="base"
      :policy="resuming"
      @resumed="onApplied"
      @failed="refresh()"
    />
  </div>
</template>
