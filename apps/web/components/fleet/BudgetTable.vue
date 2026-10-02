<template>
  <div class="overflow-x-auto" :data-testid="testid">
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('fleet.budgets.table.scope') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.window') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.spend') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.rules') }}</TableHead>
          <TableHead>{{ t('fleet.budgets.table.status') }}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="policy in policies"
          :key="policy.id"
          :data-testid="`fleet-budget-row-${policy.id}`"
          :data-status="budgetStatus(policy)"
        >
          <TableCell>
            <div class="font-medium">{{ label('fleet.budgets.scope', policy.scopeType) }}</div>
            <div v-if="scopeName(policy)" class="break-all text-xs text-muted-foreground">{{ scopeName(policy) }}</div>
          </TableCell>
          <TableCell>
            <div>{{ label('fleet.budgets.window', policy.windowKind) }}</div>
            <div v-if="policy.windowKind === 'calendar_month_utc'" class="text-xs text-muted-foreground">
              {{ t('fleet.budgets.windowSince', { date: windowSinceDate(policy.windowStart) }) }}
            </div>
          </TableCell>
          <TableCell class="min-w-[10rem]">
            <div data-testid="fleet-budget-spend">
              {{ t('fleet.budgets.spend.of', { spent: formatUsd(policy.spentUsd), amount: formatUsd(policy.amountUsd) }) }}
            </div>
            <div
              class="mt-1 h-1.5 w-full rounded bg-muted"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="percent(policy)"
            >
              <div class="h-1.5 rounded" :class="barClass(policy)" :style="{ width: `${percent(policy)}%` }" />
            </div>
            <div class="text-xs text-muted-foreground">{{ t('fleet.budgets.spend.percent', { percent: percent(policy) }) }}</div>
          </TableCell>
          <TableCell class="text-sm">
            <div>{{ policy.warnPercent === null ? t('fleet.budgets.rules.noWarn') : t('fleet.budgets.rules.warnAt', { percent: policy.warnPercent }) }}</div>
            <div>{{ policy.hardStop ? t('fleet.budgets.rules.hardStopOn') : t('fleet.budgets.rules.hardStopOff') }}</div>
            <div v-if="policy.hardStop">
              {{ policy.runningJobs === 'cancel' ? t('fleet.budgets.rules.runningCancel') : t('fleet.budgets.rules.runningFinish') }}
            </div>
          </TableCell>
          <TableCell>
            <Badge :variant="badgeVariant(policy)" data-testid="fleet-budget-status">{{ label('fleet.budgets.status', budgetStatus(policy)) }}</Badge>
            <div v-if="policy.paused && policy.pausedAt" class="mt-1 text-xs text-muted-foreground">
              {{ t('fleet.budgets.pausedSince', { at: new Date(policy.pausedAt).toLocaleString() }) }}
            </div>
          </TableCell>
          <TableCell class="space-x-1 whitespace-nowrap text-right">
            <template v-if="editable">
              <Button v-if="policy.paused" size="sm" data-testid="fleet-budget-resume" @click="emit('resume', policy)">
                {{ t('fleet.budgets.actions.resume') }}
              </Button>
              <Button size="sm" variant="outline" data-testid="fleet-budget-edit" @click="emit('edit', policy)">
                {{ t('fleet.budgets.actions.edit') }}
              </Button>
              <Button size="sm" variant="destructive" data-testid="fleet-budget-delete" @click="emit('remove', policy)">
                {{ t('fleet.budgets.actions.delete') }}
              </Button>
            </template>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import { budgetStatus, spendPercent, windowSinceDate } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

defineProps<{
  policies: BudgetPolicyDto[]
  /** Shows Resume, Edit and Delete; a read-only table (members, fleet-wide policies on a project page) has no buttons. */
  editable: boolean
  scopeName: (policy: BudgetPolicyDto) => string | null
  testid?: string
}>()

const emit = defineEmits<{
  (e: 'edit', policy: BudgetPolicyDto): void
  (e: 'remove', policy: BudgetPolicyDto): void
  (e: 'resume', policy: BudgetPolicyDto): void
}>()

const { t, te } = useI18n()

const label = (prefix: string, code: string): string => codeLabel(t, te, prefix, code)
const percent = (policy: BudgetPolicyDto): number => spendPercent(policy.spentUsd, policy.amountUsd)

const BAR_CLASS = { paused: 'bg-destructive', warning: 'bg-secondary-foreground', ok: 'bg-primary' } as const
const BADGE_VARIANT = { paused: 'destructive', warning: 'secondary', ok: 'outline' } as const
const barClass = (policy: BudgetPolicyDto): string => BAR_CLASS[budgetStatus(policy)]
const badgeVariant = (policy: BudgetPolicyDto) => BADGE_VARIANT[budgetStatus(policy)]
</script>
