<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { PRIORITIES } from '~/composables/useTicketOptions'
import MarkdownEditor from '~/components/MarkdownEditor.vue'

interface Ticket {
  title: string
  description?: string | null
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
}

const props = defineProps<{
  open: boolean
  ticket: Ticket
  projectSlug: string
  ticketRef: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'saved'): void
}>()

const { t } = useI18n()
const toast = useAppToast()

const formSchema = toTypedSchema(
  z.object({
    title: z.string().min(3, t('tickets.validation.titleMin')),
    priority: z.enum(PRIORITIES as unknown as [string, ...string[]]),
    description: z.string().optional(),
  }) as any
)

const { handleSubmit, isSubmitting, resetForm, setValues } = useForm({
  validationSchema: formSchema,
})

// Sync props.ticket to form when dialog opens
watch(
  () => props.open,
  (isOpen) => {
    if (isOpen && props.ticket) {
      setValues({
        title: props.ticket.title,
        priority: props.ticket.priority,
        description: props.ticket.description ?? '',
      })
    }
  }
)

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.patch(
      `/projects/${props.projectSlug}/tickets/${props.ticketRef}`,
      formValues as Record<string, unknown>
    )
    toast.success(t('tickets.toast.updated'))
    emit('saved')
    emit('update:open', false)
    resetForm()
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
})
</script>

<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[600px]">
      <DialogHeader>
        <DialogTitle>{{ t('tickets.form.editTitle') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <!-- Title -->
        <FormField name="title" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.titleLabel') }}</FormLabel>
            <FormControl>
              <Input v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <!-- Priority -->
        <FormField name="priority" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.priority') }}</FormLabel>
            <Select v-bind="componentField">
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem v-for="p in PRIORITIES" :key="p" :value="p">
                  {{ t(`tickets.priority.${p}`) }}
                </SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        </FormField>

        <!-- Description with Markdown Editor -->
        <FormField name="description" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.description') }}</FormLabel>
            <FormControl>
              <MarkdownEditor
                v-bind="componentField"
                :placeholder="t('tickets.form.descriptionPlaceholder')"
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
            {{ isSubmitting ? t('tickets.form.saving') : t('tickets.form.save') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
