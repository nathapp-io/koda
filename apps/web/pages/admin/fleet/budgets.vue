<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useFleetBudgetPage } from '~/composables/useFleetBudgetPage'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { isManagedOn, scopeName, scopeText } from '~/lib/fleet-budgets'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

definePageMeta({ layout: 'default' })

/** Not project-scoped, so there is no event stream: poll like the Runners page (D178). */
const POLL_MS = 15_000

const base: BudgetBase = { kind: 'admin' }
const { t } = useI18n()
const runnersApi = useFleetRunners()
const {
  policies, pending, loadFailed, stale, forbidden, editOpen, editing, resumeOpen, resuming,
  refresh, openCreate, openEdit, openResume, remove, onApplied,
} = useFleetBudgetPage(base)

// D174: this prefix only acts on global and runner policies, so only those are listed.
const rows = computed(() => policies.value.filter((p) => isManagedOn('admin', p)))
const runnerOptions = computed(() => runnersApi.runners.value.map((r) => ({ value: r.id, label: r.name })))
const runnerName = (id: string): string => runnersApi.runners.value.find((r) => r.id === id)?.name ?? id
const nameOf = (p: BudgetPolicyDto): string | null => scopeName(p, { project: null, repo: (id) => id, runner: runnerName })
const confirmText = (p: BudgetPolicyDto): string => t('fleet.budgets.deleteConfirm', { scope: scopeText(t, p, nameOf(p)) })

async function poll(): Promise<void> {
  await refresh()
  if (forbidden.value) polling.stop()
}

// Declared after poll, which it runs; poll only reaches `polling` when it is called.
const polling = useVisiblePolling(poll, POLL_MS)

onMounted(() => {
  void polling.runNow()
  polling.start()
  // Runner names are cosmetic: a failure leaves ids on screen.
  void runnersApi.load().catch(() => undefined)
})
onBeforeUnmount(polling.stop)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('fleet.budgets.title')" :subtitle="t('fleet.budgets.subtitleAdmin')">
      <template #actions>
        <Button :disabled="forbidden" data-testid="fleet-budget-create" @click="openCreate()">
          {{ t('fleet.budgets.actions.create') }}
        </Button>
      </template>
    </PageHeader>

    <p v-if="forbidden" class="text-sm text-muted-foreground">{{ t('fleet.common.adminOnly') }}</p>

    <template v-else>
      <p v-if="stale" class="text-sm text-muted-foreground">{{ t('fleet.common.stale') }}</p>
      <LoadingState v-if="pending" />
      <ErrorState v-else-if="loadFailed" @retry="refresh()" />
      <EmptyState v-else-if="rows.length === 0" :message="t('fleet.budgets.empty')" />
      <FleetBudgetTable
        v-else
        testid="fleet-budgets-admin"
        :policies="rows"
        :editable="true"
        :scope-name="nameOf"
        @edit="openEdit"
        @resume="openResume"
        @remove="(p) => remove(p, confirmText(p))"
      />
    </template>

    <FleetBudgetEditDialog
      v-model:open="editOpen"
      :base="base"
      :policy="editing"
      :runner-options="runnerOptions"
      @saved="onApplied"
      @failed="refresh()"
    />
    <FleetBudgetResumeDialog
      v-if="resuming"
      :key="resuming.id"
      v-model:open="resumeOpen"
      :base="base"
      :policy="resuming"
      @resumed="onApplied"
      @failed="refresh()"
    />
  </div>
</template>
