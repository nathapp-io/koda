<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('vcs.importIssue.title') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="issueNumber" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('vcs.importIssue.label') }}</FormLabel>
            <FormControl>
              <Input
                :placeholder="t('vcs.importIssue.placeholder')"
                type="number"
                v-bind="componentField"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('common.loading') : t('vcs.importIssue.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

const props = defineProps<{
  open: boolean
  projectSlug: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
}>()

const { t } = useI18n()
const toast = useAppToast()

const formSchema = toTypedSchema(
  z.object({
    issueNumber: z.coerce
      .number()
      .int()
      .positive(t('vcs.importIssue.validation.invalidNumber')),
  })
)

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: {
    issueNumber: 0,
  },
})

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    const issueNumber = formValues.issueNumber as number
    const response = await $api.post<{ ref: string }>(
      `/projects/${props.projectSlug}/vcs/sync/${issueNumber}`
    )
    toast.success(t('vcs.importIssue.success', { ref: response.ref }))
    emit('update:open', false)
    resetForm()
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
})
</script>
