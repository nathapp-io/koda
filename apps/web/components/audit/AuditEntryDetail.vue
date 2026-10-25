<script setup lang="ts">
import { computed } from 'vue'
import type { AuditEntry } from '~/composables/useAuditLog'
import { principalLabel } from '~/lib/audit-log'

/**
 * The provenance and approval block an audit row expands into (Permissions P2, design §6): where the
 * write entered the system, the request it belonged to, what policy demanded and who approved it, and
 * the one on behalf of whom it happened. Every string here comes from the entry's own DTO — nothing is
 * inferred, and a value the API did not send is omitted rather than shown as a dash, so the block
 * never claims a detail the record does not carry.
 */
const props = defineProps<{ entry: AuditEntry }>()
const emit = defineEmits<{
  (e: 'related', correlationId: string): void
  (e: 'approver', approverId: string): void
}>()

const { t } = useI18n()

/** The values the API's enums carry; anything else is shown raw instead of as a translation key. */
const ORIGINS = ['rest', 'mcp', 'thread', 'runner', 'system'] as const
const APPROVAL_MODES = ['none', 'self', 'agent', 'human'] as const

function labelled(kind: 'origin' | 'approvalMode', value: string, known: readonly string[]): string {
  return known.includes(value) ? t(`admin.audit.${kind}.${value}`) : value
}

const originLabel = computed(() => labelled('origin', props.entry.origin, ORIGINS))
// `requiredMode` and `satisfiedBy` share the four approval-mode values, so they share their labels.
const requiredModeLabel = computed(() => labelled('approvalMode', props.entry.approval.requiredMode, APPROVAL_MODES))
const satisfiedByLabel = computed(() => labelled('approvalMode', props.entry.approval.satisfiedBy, APPROVAL_MODES))

/** The approver as the API named it, else the raw principal id — a deleted principal still reads. */
const approverLabel = computed(() => {
  const type = props.entry.approval.approverType
  const id = props.entry.approval.approverId
  if (type === null || id === null) return null
  return principalLabel({ type, id }, props.entry.display.approver)
})

/** The write was performed for someone else (a system component or the assistant on a principal's behalf). */
const onBehalfLabel = computed(() => (props.entry.onBehalfOf === null
  ? null
  : principalLabel(props.entry.onBehalfOf, props.entry.display.onBehalfOf)))

/**
 * An action that needed no approval has no approver, and a request id beside "Satisfied by: None"
 * would claim a decision that never happened — the assistant records such an id internally. So the
 * request id is only evidence of an approval when something actually approved the write.
 */
const requestId = computed(() => {
  const id = props.entry.approval.requestId
  if (id === null) return null
  return props.entry.approval.satisfiedBy === 'none' && approverLabel.value === null ? null : id
})
</script>

<template>
  <div class="grid gap-3 text-sm sm:grid-cols-3" data-testid="audit-detail">
    <div class="flex flex-col gap-0.5" data-field="origin">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.origin') }}</span>
      <span>{{ originLabel }}</span>
    </div>

    <div class="flex flex-col gap-0.5" data-field="correlationId">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.correlationId') }}</span>
      <span class="flex flex-wrap items-center gap-2">
        <code class="text-xs">{{ entry.correlationId }}</code>
        <Button
          variant="outline"
          size="sm"
          class="h-7 px-2 text-xs"
          data-testid="audit-show-related"
          @click="emit('related', entry.correlationId)"
        >
          {{ t('admin.audit.detail.showRelated') }}
        </Button>
      </span>
    </div>

    <div class="flex flex-col gap-0.5" data-field="requiredMode">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.requiredMode') }}</span>
      <span>{{ requiredModeLabel }}</span>
    </div>

    <div class="flex flex-col gap-0.5" data-field="satisfiedBy">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.satisfiedBy') }}</span>
      <span>{{ satisfiedByLabel }}</span>
    </div>

    <div v-if="approverLabel" class="flex flex-col gap-0.5" data-field="approver">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.approver') }}</span>
      <button
        type="button"
        class="w-fit text-left hover:underline"
        data-testid="audit-approver"
        :title="t('admin.audit.filter.byApprover')"
        @click="emit('approver', entry.approval.approverId as string)"
      >
        {{ approverLabel }}
      </button>
    </div>

    <div v-if="requestId" class="flex flex-col gap-0.5" data-field="requestId">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.requestId') }}</span>
      <code class="text-xs">{{ requestId }}</code>
    </div>

    <div v-if="onBehalfLabel" class="flex flex-col gap-0.5" data-field="onBehalfOf">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.onBehalfOf') }}</span>
      <span>{{ onBehalfLabel }}</span>
    </div>

    <div class="flex flex-col gap-0.5" data-field="createdAt">
      <span class="text-xs font-medium text-muted-foreground">{{ t('admin.audit.detail.createdAt') }}</span>
      <time :datetime="entry.createdAt" class="text-xs">{{ entry.createdAt }}</time>
    </div>
  </div>
</template>
