<template>
  <div class="space-y-3">
    <EmptyState v-if="policies.length === 0" :message="t('approvals.policies.list.empty')" />
    <Table v-else data-testid="policy-list">
      <TableHeader>
        <TableRow>
          <TableHead>{{ t('approvals.policies.list.pattern') }}</TableHead>
          <TableHead>{{ t('approvals.policies.list.subject') }}</TableHead>
          <TableHead>{{ t('approvals.policies.list.mode') }}</TableHead>
          <TableHead>{{ t('approvals.policies.list.timeout') }}</TableHead>
          <TableHead>{{ t('approvals.policies.list.onTimeout') }}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="policy in policies"
          :key="policy.id"
          data-testid="policy-row"
          :data-id="policy.id"
          :data-pattern="policy.permissionPattern"
          :data-inherited="String(isInherited(policy))"
        >
          <TableCell>
            <code>{{ policy.permissionPattern }}</code>
            <span v-if="isInherited(policy)" class="ml-2 text-xs text-muted-foreground" data-testid="policy-inherited">
              {{ t('approvals.policies.project.inherited') }}
            </span>
          </TableCell>
          <TableCell data-testid="policy-row-subject">{{ policySubjectText(t, policy) }}</TableCell>
          <TableCell data-testid="policy-row-mode">{{ t(`approvals.policies.mode.${policy.mode}`) }}</TableCell>
          <TableCell data-testid="policy-row-timeout">
            {{ policy.timeoutSec === null ? t('approvals.policies.list.noTimeout') : t('approvals.policies.list.timeoutSeconds', { count: policy.timeoutSec }) }}
          </TableCell>
          <TableCell data-testid="policy-row-on-timeout">
            {{ t(policy.onTimeout === 'approve' ? 'approvals.policies.dialog.onTimeoutApprove' : 'approvals.policies.dialog.onTimeoutReject') }}
          </TableCell>
          <TableCell class="text-right">
            <template v-if="canManage && !isInherited(policy)">
              <Button size="sm" variant="outline" data-testid="policy-edit" @click="$emit('edit', policy)">
                <Pencil class="mr-1 h-3.5 w-3.5" />{{ t('approvals.policies.list.edit') }}
              </Button>
              <Button size="sm" variant="outline" class="ml-2" data-testid="policy-delete" @click="$emit('remove', policy)">
                <Trash2 class="mr-1 h-3.5 w-3.5" />{{ t('approvals.policies.list.delete') }}
              </Button>
            </template>
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
</template>

<script setup lang="ts">
/**
 * P3b US-008: the policy list, shared by the global page and (US-009) the project page.
 *
 * It renders and emits; the page owns the confirmation and the request, because a delete's failure
 * handling belongs beside the reload. A policy whose `projectId` is null on a project page is a
 * global one the project inherits, so it lists read-only (US-009).
 */
import { Pencil, Trash2 } from 'lucide-vue-next'
import { policySubjectText } from '~/lib/approval-policies'
import type { ApprovalPolicy, PolicyBase } from '~/lib/approval-policies'

const props = withDefaults(defineProps<{
  base: PolicyBase
  policies: ApprovalPolicy[]
  /** Writes need `approval.policy.manage`; without it the rows render without their actions. */
  canManage?: boolean
}>(), { canManage: true })

defineEmits<{
  (e: 'edit', policy: ApprovalPolicy): void
  (e: 'remove', policy: ApprovalPolicy): void
}>()

const { t } = useI18n()

/**
 * A global policy inside a project's list: the project inherits it, so the row offers no action.
 * US-009 owns the label that marks such a row (`approvals.policies.project`), which is why the row
 * only carries the `data-inherited` marker here.
 */
const isInherited = (policy: ApprovalPolicy): boolean =>
  props.base.kind === 'project' && policy.projectId === null
</script>
