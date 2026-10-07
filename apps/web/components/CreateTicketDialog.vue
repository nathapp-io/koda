<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('tickets.form.title') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="title" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.titleLabel') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('tickets.form.titlePlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="type" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.type') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect
                v-bind="componentField"
                id="type"
                :options="typeOptions"
                :placeholder="t('tickets.form.typePlaceholder')"
                testid="create-ticket-type"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="priority" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.priority') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect
                v-bind="componentField"
                id="priority"
                :options="priorityOptions"
                :placeholder="t('tickets.form.priorityPlaceholder')"
                testid="create-ticket-priority"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="description" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.description') }}</FormLabel>
            <FormControl>
              <MarkdownEditor v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('tickets.form.creating') : t('tickets.form.create') }}
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
import MarkdownEditor from '~/components/MarkdownEditor.vue'
import { apiPath } from '~/lib/api-path'

const props = defineProps<{
  open: boolean
  projectSlug: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()
const toast = useAppToast()

const typeOptions = computed(() => [
  { value: 'BUG', label: t('tickets.type.BUG') },
  { value: 'ENHANCEMENT', label: t('tickets.type.ENHANCEMENT') },
  { value: 'TASK', label: t('tickets.type.TASK') },
  { value: 'QUESTION', label: t('tickets.type.QUESTION') },
])

const priorityOptions = computed(() => [
  { value: 'LOW', label: t('tickets.priority.LOW') },
  { value: 'MEDIUM', label: t('tickets.priority.MEDIUM') },
  { value: 'HIGH', label: t('tickets.priority.HIGH') },
  { value: 'CRITICAL', label: t('tickets.priority.CRITICAL') },
])

const formSchema = toTypedSchema(
  z.object({
    title: z.string().min(3, t('tickets.validation.titleMin')),
    type: z.enum(['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'], {
      errorMap: () => ({ message: t('tickets.validation.typeRequired') }),
    }),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    description: z.string().optional(),
  })
)

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: {
    title: '',
    type: undefined,
    priority: 'MEDIUM',
    description: '',
  },
})

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.post(apiPath`/projects/${props.projectSlug}/tickets`, formValues as Record<string, unknown>)
    toast.success(t('tickets.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
})
</script>
