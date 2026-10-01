<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.runners.edit.title', { name: runner.name }) }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="labels">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.edit.labels') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.runners.edit.labelsHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="capacity">
          <FormItem>
            <FormLabel>{{ t('fleet.runners.edit.capacity') }}</FormLabel>
            <FormControl><Input type="number" :min="CAPACITY_MIN" :max="CAPACITY_MAX" v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.runners.edit.submitting') : t('fleet.runners.edit.submit') }}
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
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { CAPACITY_MAX, CAPACITY_MIN, parseLabels } from '~/lib/fleet-validation'
import type { FleetRunner } from '~/lib/fleet-types'

const props = defineProps<{ open: boolean; runner: FleetRunner }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved', runner: FleetRunner): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { update } = useFleetRunners()

const formSchema = toTypedSchema(z.object({
  labels: z.string().superRefine((value, ctx) => {
    const parsed = parseLabels(value)
    if (parsed.ok) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: parsed.error === 'tooMany' ? t('fleet.validation.labelsTooMany') : t('fleet.validation.labelInvalid', { label: parsed.label }),
    })
  }),
  capacity: z.coerce.number({ invalid_type_error: t('fleet.validation.capacityRange') })
    .int(t('fleet.validation.capacityRange'))
    .min(CAPACITY_MIN, t('fleet.validation.capacityRange'))
    .max(CAPACITY_MAX, t('fleet.validation.capacityRange')),
}))

const initialValues = () => ({ labels: props.runner.labels.join(', '), capacity: props.runner.capacity })

const { handleSubmit, isSubmitting, resetForm } = useForm({ validationSchema: formSchema, initialValues: initialValues() })

// The dialog is reused across rows: reload the values whenever it opens for a runner.
watch(() => [props.open, props.runner.id] as const, ([open]) => {
  if (open) resetForm({ values: initialValues() })
})

const onSubmit = handleSubmit(async (values) => {
  const parsed = parseLabels(values.labels)
  if (!parsed.ok) return
  try {
    const saved = await update(props.runner.id, { labels: parsed.labels, capacity: values.capacity })
    toast.success(t('fleet.runners.toast.updated'))
    emit('saved', saved)
    emit('update:open', false)
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
