<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ policy ? t('fleet.budgets.form.editTitle') : t('fleet.budgets.form.createTitle') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" data-testid="fleet-budget-form" @submit="onSubmit">
        <template v-if="!policy">
          <FormField v-slot="{ componentField }" name="scopeType">
            <FormItem>
              <FormLabel>{{ t('fleet.budgets.form.scopeType') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="scopeOptions" testid="fleet-budget-scope-type" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>

          <template v-if="needsTarget">
            <FormField v-slot="{ componentField }" name="scopeId">
              <FormItem>
                <FormLabel>{{ targetLabel }}</FormLabel>
                <FormControl>
                  <FleetNativeSelect
                    v-bind="componentField"
                    :options="targetOptions"
                    :placeholder="t('fleet.budgets.form.choosePlaceholder')"
                    testid="fleet-budget-scope-id"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            </FormField>
          </template>

          <FormField v-slot="{ componentField }" name="windowKind">
            <FormItem>
              <FormLabel>{{ t('fleet.budgets.form.windowKind') }}</FormLabel>
              <FormControl>
                <FleetNativeSelect v-bind="componentField" :options="windowOptions" testid="fleet-budget-window" />
              </FormControl>
              <FormMessage />
            </FormItem>
          </FormField>
        </template>
        <p v-else class="text-sm text-muted-foreground" data-testid="fleet-budget-fixed-hint">{{ t('fleet.budgets.form.fixedHint') }}</p>

        <FormField v-slot="{ componentField }" name="amountUsd">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.amount') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-budget-amount" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.form.amountHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="warnPercent">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.warnPercent') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="numeric" data-testid="fleet-budget-warn" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.budgets.form.warnHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="hardStop">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.hardStop') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="hardStopOptions" testid="fleet-budget-hard-stop" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="runningJobs">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.form.runningJobs') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="runningOptions" testid="fleet-budget-running-jobs" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-budget-submit">
            {{ isSubmitting ? t('fleet.budgets.form.submitting') : t('fleet.budgets.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { buildBudgetSchema, initialFormValues, needsScopeId, scopesFor, toCreateBody, toPatchBody } from '~/lib/fleet-budgets'
import { BUDGET_RUNNING_JOBS, BUDGET_WINDOW_KINDS } from '~/lib/fleet-types'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

const props = withDefaults(defineProps<{
  open: boolean
  base: BudgetBase
  /** null creates a policy; a policy edits it (scope and window stay fixed, 2a D161). */
  policy: BudgetPolicyDto | null
  repoOptions?: Array<{ value: string; label: string }>
  runnerOptions?: Array<{ value: string; label: string }>
}>(), { repoOptions: () => [], runnerOptions: () => [] })

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', policy: BudgetPolicyDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create, update } = useFleetBudgets(props.base)

const scopeOptions = computed(() => scopesFor(props.base.kind).map((scope) => ({ value: scope, label: t(`fleet.budgets.scope.${scope}`) })))
const windowOptions = computed(() => BUDGET_WINDOW_KINDS.map((kind) => ({ value: kind, label: t(`fleet.budgets.window.${kind}`) })))
const hardStopOptions = computed(() => [
  { value: 'true', label: t('fleet.budgets.hardStop.on') },
  { value: 'false', label: t('fleet.budgets.hardStop.off') },
])
const runningOptions = computed(() => BUDGET_RUNNING_JOBS.map((mode) => ({ value: mode, label: t(`fleet.budgets.runningJobs.${mode}`) })))

const { handleSubmit, isSubmitting, resetForm, values: formValues, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildBudgetSchema(t)),
  initialValues: initialFormValues(props.base.kind, props.policy),
})

const needsTarget = computed(() => needsScopeId(formValues.scopeType ?? 'global'))
const targetOptions = computed(() => (formValues.scopeType === 'runner' ? props.runnerOptions : props.repoOptions))
const targetLabel = computed(() => (formValues.scopeType === 'runner' ? t('fleet.budgets.form.scopeRunner') : t('fleet.budgets.form.scopeRepo')))

// The dialog is reused across rows and between create and edit: reload the values whenever it opens.
watch(() => [props.open, props.policy?.id] as const, ([open]) => {
  if (open) resetForm({ values: initialFormValues(props.base.kind, props.policy) })
})

// A target picked for one scope type means nothing for the other.
watch(() => formValues.scopeType, (next, previous) => {
  if (!props.policy && next !== previous) setFieldValue('scopeId', '')
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const saved = props.policy
      ? await update(props.policy.id, toPatchBody(values))
      : await create(toCreateBody(values))
    toast.success(t(props.policy ? 'fleet.budgets.toast.updated' : 'fleet.budgets.toast.created'))
    emit('saved', saved)
    emit('update:open', false)
  } catch (err: unknown) {
    // D185: stay open so the admin keeps their input; the page reloads in case the view is stale.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
