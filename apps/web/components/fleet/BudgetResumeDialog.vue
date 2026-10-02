<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.budgets.resume.title') }}</DialogTitle>
      </DialogHeader>

      <p class="text-sm" data-testid="fleet-budget-resume-summary">
        {{ t('fleet.budgets.resume.summary', { spent: formatUsd(policy.spentUsd), amount: formatUsd(policy.amountUsd) }) }}
      </p>

      <form class="space-y-4" data-testid="fleet-budget-resume-form" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="amountUsd">
          <FormItem>
            <FormLabel>{{ t('fleet.budgets.resume.amount') }}</FormLabel>
            <FormControl><Input v-bind="componentField" inputmode="decimal" data-testid="fleet-budget-resume-amount" /></FormControl>
            <p class="text-xs text-muted-foreground" data-testid="fleet-budget-resume-hint">
              {{ needsRaise ? t('fleet.budgets.resume.raiseHint') : t('fleet.budgets.resume.keepHint') }}
            </p>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting" data-testid="fleet-budget-resume-submit">
            {{ isSubmitting ? t('fleet.budgets.resume.submitting') : t('fleet.budgets.resume.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetBudgets } from '~/composables/useFleetBudgets'
import type { BudgetBase } from '~/composables/useFleetBudgets'
import { buildResumeSchema, isAboveSpend, toResumeAmount } from '~/lib/fleet-budgets'
import { formatUsd } from '~/lib/fleet-jobs'
import type { BudgetPolicyDto } from '~/lib/fleet-types'

// Mounted per policy (`v-if` + `:key` on the page), so the schema below is built once for this policy.
const props = defineProps<{ open: boolean; base: BudgetBase; policy: BudgetPolicyDto }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'resumed', policy: BudgetPolicyDto): void
  (e: 'failed'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { resume } = useFleetBudgets(props.base)

/** D184: a limit that is not above the spend cannot be kept, a new one is required. */
const needsRaise = !isAboveSpend(props.policy.amountUsd, props.policy.spentUsd)

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: toTypedSchema(buildResumeSchema(t, props.policy)),
  initialValues: { amountUsd: '' },
})

watch(() => props.open, (open) => {
  if (open) resetForm()
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const resumed = await resume(props.policy.id, toResumeAmount(values.amountUsd))
    toast.success(t('fleet.budgets.toast.resumed'))
    emit('resumed', resumed)
    emit('update:open', false)
  } catch (err: unknown) {
    // D185: 409 fleet.budgetNotPaused or 404 means the view is stale; the server's message says which.
    toast.error(extractApiError(err))
    emit('failed')
  }
})
</script>
