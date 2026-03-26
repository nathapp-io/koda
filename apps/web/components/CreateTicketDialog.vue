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
            <Select v-bind="componentField">
              <FormControl>
                <SelectTrigger>
                  <SelectValue :placeholder="t('tickets.form.typePlaceholder')" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="BUG">{{ t('tickets.type.BUG') }}</SelectItem>
                <SelectItem value="ENHANCEMENT">{{ t('tickets.type.ENHANCEMENT') }}</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="priority" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.priority') }}</FormLabel>
            <Select v-bind="componentField">
              <FormControl>
                <SelectTrigger>
                  <SelectValue :placeholder="t('tickets.form.priorityPlaceholder')" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="LOW">{{ t('tickets.priority.LOW') }}</SelectItem>
                <SelectItem value="MEDIUM">{{ t('tickets.priority.MEDIUM') }}</SelectItem>
                <SelectItem value="HIGH">{{ t('tickets.priority.HIGH') }}</SelectItem>
                <SelectItem value="CRITICAL">{{ t('tickets.priority.CRITICAL') }}</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="description" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('tickets.form.description') }}</FormLabel>
            <FormControl>
              <Textarea :placeholder="t('tickets.form.descriptionPlaceholder')" v-bind="componentField" />
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
import { toast } from 'vue-sonner'

const props = defineProps<{
  open: boolean
  projectSlug: string
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()

const formSchema = toTypedSchema(
  z.object({
    title: z.string().min(3, t('tickets.validation.titleMin')),
    type: z.string()
      .min(1, t('tickets.validation.typeRequired'))
      .refine((v: string) => ['BUG', 'ENHANCEMENT'].includes(v), t('tickets.validation.typeRequired')),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
    description: z.string().optional(),
  }) as any
)

const { handleSubmit, isSubmitting } = useForm({
  validationSchema: formSchema,
  initialValues: {
    title: '',
    type: '',
    priority: 'MEDIUM',
    description: '',
  },
})

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.post(`/projects/${props.projectSlug}/tickets`, formValues as Record<string, unknown>)
    toast.success(t('tickets.toast.created'))
    emit('created')
    emit('update:open', false)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : t('tickets.toast.createFailed')
    toast.error(message)
  }
})
</script>
