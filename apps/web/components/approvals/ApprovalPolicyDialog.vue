<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ t('approvals.policies.dialog.description') }}</DialogDescription>
      </DialogHeader>

      <form v-if="open" class="space-y-4" data-testid="policy-form" @submit="onSubmit">
        <!-- The pattern and the subject are part of the selector, so only a new policy names them. -->
        <template v-if="!policy">
          <div class="space-y-1">
            <Label for="policy-pattern">{{ t('approvals.policies.dialog.pattern') }}</Label>
            <Input id="policy-pattern" v-model="patternInput" data-testid="policy-pattern" autocomplete="off" />
            <p class="text-xs text-muted-foreground">{{ t('approvals.policies.dialog.patternHint') }}</p>
            <p v-if="patternMissing" class="text-sm font-medium text-status-rejected" data-testid="policy-pattern-error">
              {{ t('approvals.policies.validation.pattern') }}
            </p>
          </div>

          <div class="space-y-1">
            <Label for="policy-subject-kind">{{ t('approvals.policies.dialog.subject') }}</Label>
            <select
              id="policy-subject-kind"
              data-testid="policy-subject-kind"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              :value="subjectKind"
              @change="onSubjectKindChange"
            >
              <option v-for="kind in subjectKinds" :key="kind" :value="kind">
                {{ t(`approvals.policies.dialog.subjectKind.${kind}`) }}
              </option>
            </select>
          </div>

          <div v-if="subjectKind === 'type'" class="space-y-1">
            <Label for="policy-principal-type">{{ t('approvals.policies.dialog.principalType') }}</Label>
            <select
              id="policy-principal-type"
              data-testid="policy-principal-type"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              :value="principalType"
              @change="onPrincipalTypeChange"
            >
              <option v-for="type in PRINCIPAL_TYPES" :key="type" :value="type">
                {{ t(`approvals.policies.principal.${type}`) }}
              </option>
            </select>
          </div>

          <div v-if="subjectKind === 'role'" class="space-y-1">
            <Label for="policy-role">{{ t('approvals.policies.dialog.role') }}</Label>
            <select
              id="policy-role"
              data-testid="policy-role"
              class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              :value="roleId"
              @change="onRoleChange"
            >
              <option value="">{{ t('approvals.policies.dialog.chooseRole') }}</option>
              <option v-for="role in roleChoices" :key="role.value" :value="role.value">{{ role.label }}</option>
            </select>
            <p v-if="roleMissing" class="text-sm font-medium text-status-rejected" data-testid="policy-role-error">
              {{ t('approvals.policies.validation.role') }}
            </p>
          </div>
        </template>
        <p v-else class="text-sm text-muted-foreground" data-testid="policy-selector">
          <code>{{ policy.permissionPattern }}</code> · {{ policySubjectText(t, policy) }}
        </p>

        <div class="space-y-1">
          <Label for="policy-mode">{{ t('approvals.policies.dialog.mode') }}</Label>
          <select
            id="policy-mode"
            data-testid="policy-mode"
            class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            :value="mode"
            @change="onModeChange"
          >
            <option v-for="option in modeChoices" :key="option" :value="option">
              {{ t(`approvals.policies.mode.${option}`) }}
            </option>
          </select>
          <p class="text-xs text-muted-foreground">{{ t('approvals.policies.dialog.modeHint') }}</p>
          <p v-if="errors.mode" class="text-sm font-medium text-status-rejected" data-testid="policy-mode-error">{{ errors.mode }}</p>
        </div>

        <div class="space-y-1">
          <Label for="policy-timeout">{{ t('approvals.policies.dialog.timeout') }}</Label>
          <Input id="policy-timeout" v-model="timeoutSec" data-testid="policy-timeout" inputmode="numeric" />
          <p class="text-xs text-muted-foreground">{{ t('approvals.policies.dialog.timeoutHint') }}</p>
          <p v-if="errors.timeoutSec" class="text-sm font-medium text-status-rejected" data-testid="policy-timeout-error">{{ errors.timeoutSec }}</p>
        </div>

        <div class="space-y-1">
          <Label for="policy-on-timeout">{{ t('approvals.policies.dialog.onTimeout') }}</Label>
          <select
            id="policy-on-timeout"
            data-testid="policy-on-timeout"
            class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            :value="onTimeout"
            @change="onOnTimeoutChange"
          >
            <option value="reject">{{ t('approvals.policies.dialog.onTimeoutReject') }}</option>
            <option value="approve">{{ t('approvals.policies.dialog.onTimeoutApprove') }}</option>
          </select>
          <p v-if="errors.onTimeout" class="text-sm font-medium text-status-rejected" data-testid="policy-on-timeout-error">{{ errors.onTimeout }}</p>
        </div>

        <div class="space-y-2">
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="policy-must-hold"
              :checked="approverMustHoldAction"
              @change="onMustHoldChange"
            >
            <span>{{ t('approvals.policies.dialog.approverMustHoldAction') }}</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="policy-distinct"
              :checked="requireDistinctApprover"
              @change="onDistinctChange"
            >
            <span>{{ t('approvals.policies.dialog.requireDistinctApprover') }}</span>
          </label>
        </div>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" data-testid="policy-save" :disabled="isSubmitting || !saveable">
            {{ isSubmitting ? t('approvals.policies.dialog.saving') : t('approvals.policies.dialog.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
/**
 * P3b US-008: the one policy dialog, shared by the global page and (US-009) the project page.
 *
 * A **create** names the selector — the permission pattern and the subject — plus the mode and the
 * on-timeout choice. An **edit** changes only what `PATCH` accepts: mode, timeout, on-timeout and the
 * two approver flags. The pattern and the subject are part of the policy's selector, so they are
 * shown, never editable.
 *
 * The mode options follow the pattern's floor (`modeOptions(patternFloor(...))`), and a pattern that
 * covers no approvable key is refused here as the API refuses it: the pattern message, Save disabled.
 *
 * The `role` subject kind needs the role vocabulary of the base — `role.read` globally, `member.read`
 * on a project — and a *successful* read. A caller without the key, or a read that fails, simply does
 * not get the kind: the other two cover the common cases, and the API is unaffected.
 *
 * Every refusal (400, 403, 409) toasts `extractApiError` and leaves the dialog open with the input.
 */
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useApprovalPolicies } from '~/composables/useApprovalPolicies'
import {
  PRINCIPAL_TYPES, buildPolicySchema, initialPolicyValues, modeOptions, patternFloor,
  policySubjectText, toCreateBody, toPatchBody,
} from '~/lib/approval-policies'
import type {
  ApprovalMode, ApprovalPolicy, ApprovableKey, PolicyBase, PolicySubjectInput, PrincipalType,
} from '~/lib/approval-policies'

const props = defineProps<{
  open: boolean
  base: PolicyBase
  /** The policy being edited, or null to create one. */
  policy: ApprovalPolicy | null
  /** The approvable keys: they decide the pattern's floor and the modes that follow from it. */
  keys: ApprovableKey[]
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', policy: ApprovalPolicy): void
}>()

type SubjectKind = 'all' | 'type' | 'role'

const { t } = useI18n()
const toast = useAppToast()
const { create, update } = useApprovalPolicies(props.base)

/** The role vocabulary of this base, and the key that lets the caller read it. */
const permissions = props.base.kind === 'project'
  ? useProjectPermissions(props.base.slug).permissions
  : useGlobalPermissions().permissions
const globalRoles = props.base.kind === 'global' ? useRoles() : null
const projectRoles = props.base.kind === 'project' ? useProjectRoles(props.base.slug) : null

const canReadRoles = computed(() =>
  permissions.value.has(props.base.kind === 'project' ? 'member.read' : 'role.read'))

const title = computed(() => t(props.policy === null ? 'approvals.policies.dialog.createTitle' : 'approvals.policies.dialog.editTitle'))

/** The selector's two halves, kept outside the schema: only a create sends them. */
const patternInput = ref('')
const subjectKind = ref<SubjectKind>('all')
const principalType = ref<PrincipalType>('AGENT')
const roleId = ref('')
const roleChoices = ref<Array<{ value: string; label: string }>>([])

const subjectKinds = computed<SubjectKind[]>(() =>
  roleChoices.value.length === 0 ? ['all', 'type'] : ['all', 'type', 'role'])

/**
 * The floor of the pattern on screen. A stored policy's own mode stands in when the key list did not
 * resolve its pattern: the mode it already has is by definition one the API accepts for its keys, so
 * the editor never offers a value the API would refuse — and never blocks an edit either.
 */
const floor = computed<ApprovalMode | null>(() => {
  const covered = patternFloor(props.policy?.permissionPattern ?? patternInput.value, props.keys)
  if (covered !== null) return covered
  return props.policy === null ? null : props.policy.mode
})

const modeChoices = computed(() => modeOptions(floor.value))
/**
 * A pattern that covers no approvable key: the API refuses it, so Save stays disabled. An empty key
 * list is not that case — it means the list itself did not load, and the API still knows the keys, so
 * the dialog lets the request through and the API's own refusal is what the admin sees.
 */
const patternMissing = computed(() => props.policy === null && props.keys.length > 0 && floor.value === null)
const roleMissing = computed(() => subjectKind.value === 'role' && roleId.value === '')
const saveable = computed(() => !patternMissing.value && !roleMissing.value)

// The schema is a computed so the floor follows the pattern as it is typed.
const { handleSubmit, isSubmitting, resetForm, defineField, errors } = useForm({
  validationSchema: computed(() => toTypedSchema(buildPolicySchema(t, floor.value))),
  initialValues: initialPolicyValues(null),
})
const [mode] = defineField('mode')
const [timeoutSec] = defineField('timeoutSec')
const [onTimeout] = defineField('onTimeout')
const [approverMustHoldAction] = defineField('approverMustHoldAction')
const [requireDistinctApprover] = defineField('requireDistinctApprover')

const subjectInput = computed<PolicySubjectInput>(() => {
  if (subjectKind.value === 'type') return { kind: 'type', principalType: principalType.value }
  if (subjectKind.value === 'role') return { kind: 'role', roleId: roleId.value }
  return { kind: 'all' }
})

/** The roles the picker offers; a caller without the key, or a failed read, gets none. */
async function fetchRoles(): Promise<Array<{ id: string; name: string }>> {
  if (projectRoles !== null) return projectRoles.load()
  if (globalRoles !== null) return globalRoles.load()
  return []
}

async function loadRoleChoices(): Promise<void> {
  if (!canReadRoles.value) {
    roleChoices.value = []
    return
  }
  try {
    const rows = await fetchRoles()
    roleChoices.value = rows.map((role) => ({ value: role.id, label: role.name }))
  } catch {
    // Intentional: an unreadable role list only costs the role kind (the API is unaffected).
    roleChoices.value = []
  }
}

/** Loads the dialog for the policy it opened with. */
async function initialise(): Promise<void> {
  resetForm({ values: initialPolicyValues(props.policy) })
  patternInput.value = props.policy?.permissionPattern ?? ''
  subjectKind.value = 'all'
  principalType.value = 'AGENT'
  roleId.value = ''
  roleChoices.value = []
  await loadRoleChoices()
}

watch(() => ({ open: props.open, id: props.policy?.id ?? null }), (state) => {
  if (state.open) void initialise()
}, { immediate: true })

/**
 * A pattern typed after a mode was chosen can raise the floor above it, which would leave the select
 * on a value it no longer offers. The mode then moves to the strictest option still on the list.
 */
watch(floor, () => {
  const current = mode.value
  if (current !== undefined && modeChoices.value.includes(current)) return
  const strictest = modeChoices.value[modeChoices.value.length - 1]
  if (strictest !== undefined) mode.value = strictest
})

function onSubjectKindChange(event: Event): void {
  subjectKind.value = (event.target as HTMLSelectElement).value as SubjectKind
}

function onPrincipalTypeChange(event: Event): void {
  principalType.value = (event.target as HTMLSelectElement).value as PrincipalType
}

function onRoleChange(event: Event): void {
  roleId.value = (event.target as HTMLSelectElement).value
}

function onModeChange(event: Event): void {
  mode.value = (event.target as HTMLSelectElement).value as ApprovalMode
}

function onOnTimeoutChange(event: Event): void {
  onTimeout.value = (event.target as HTMLSelectElement).value === 'approve' ? 'approve' : 'reject'
}

function onMustHoldChange(event: Event): void {
  approverMustHoldAction.value = (event.target as HTMLInputElement).checked
}

function onDistinctChange(event: Event): void {
  requireDistinctApprover.value = (event.target as HTMLInputElement).checked
}

const onSubmit = handleSubmit(async (values) => {
  if (!saveable.value) return
  try {
    const saved = props.policy === null
      ? await create(toCreateBody(patternInput.value, subjectInput.value, values))
      : await update(props.policy.id, toPatchBody(values))
    toast.success(t(props.policy === null ? 'approvals.policies.toast.created' : 'approvals.policies.toast.updated'))
    emit('saved', saved)
    emit('update:open', false)
  } catch (err: unknown) {
    // The dialog stays open with what was entered; the API's refusal is the message.
    toast.error(extractApiError(err))
  }
})
</script>
