<template>
  <div class="space-y-2" data-testid="approvable-keys">
    <h2 class="text-sm font-semibold">{{ t('approvals.policies.keys.title') }}</h2>
    <p class="text-xs text-muted-foreground">{{ t('approvals.policies.keys.hint') }}</p>
    <EmptyState v-if="keys.length === 0" :message="t('approvals.policies.keys.empty')" />
    <Table v-else data-testid="approvable-keys-table">
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('approvals.policies.keys.key') }}</TableHead>
          <TableHead>{{ t('approvals.policies.keys.scope') }}</TableHead>
          <TableHead>{{ t('approvals.policies.keys.risk') }}</TableHead>
          <TableHead>{{ t('approvals.policies.keys.floor') }}</TableHead>
          <TableHead>{{ t('approvals.policies.keys.default') }}</TableHead>
          <TableHead>{{ t('approvals.policies.keys.overrides') }}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="entry in keys"
          :key="entry.key"
          data-testid="approvable-key-row"
          :data-key="entry.key"
        >
          <TableCell><code>{{ entry.key }}</code></TableCell>
          <TableCell data-testid="key-scope">{{ t(`approvals.policies.scope.${entry.scope}`) }}</TableCell>
          <TableCell>
            <Badge variant="outline" :data-risk="entry.risk" data-testid="key-risk">{{ t(`approvals.policies.risk.${entry.risk}`) }}</Badge>
          </TableCell>
          <TableCell data-testid="key-floor">{{ t(`approvals.policies.mode.${entry.floor}`) }}</TableCell>
          <TableCell data-testid="key-default">{{ t(`approvals.policies.mode.${entry.default}`) }}</TableCell>
          <TableCell data-testid="key-override-count">{{ overrideCount(entry.key, policies) }}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-008: the approvable keys, their floors and defaults, and how many policies already
 * override each one.
 *
 * The floor is the API's (`ApprovableKeyDto.floor`): the weakest mode a policy for that key may
 * choose. The default is what the engine does with no policy at all. `overrides` is the count of the
 * loaded policies whose pattern covers the key — which is why `useApprovalPolicies().list()` reads
 * every page: a count over the first page of 20 would understate it.
 */
import { overrideCount } from '~/lib/approval-policies'
import type { ApprovalPolicy, ApprovableKey } from '~/lib/approval-policies'

defineProps<{
  keys: ApprovableKey[]
  /** Every policy of the base, global ones included on a project page (US-009). */
  policies: ApprovalPolicy[]
}>()

const { t } = useI18n()
</script>
