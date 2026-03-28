<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('projects.form.title') }}</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="name" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('projects.form.name') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('projects.form.namePlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="slug" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('projects.form.slug') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('projects.form.slugPlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="key" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>{{ t('projects.form.key') }}</FormLabel>
            <FormControl>
              <Input :placeholder="t('projects.form.keyPlaceholder')" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('projects.form.creating') : t('projects.form.create') }}
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
import { extractApiError } from '~/composables/useApi'

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()

const formSchema = toTypedSchema(
  z.object({
    name: z.string().min(1, t('projects.validation.nameRequired')),
    slug: z.string().min(1, t('projects.validation.slugRequired')).regex(/^[a-z0-9-]+$/, t('projects.validation.slugFormat')),
    key: z
      .string()
      .min(2, t('projects.validation.keyMin'))
      .max(6, t('projects.validation.keyMax'))
      .regex(/^[A-Z]+$/, t('projects.validation.keyFormat')),
  }) as any
)

const { handleSubmit, setFieldValue, isSubmitting, values, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { name: '', slug: '', key: '' },
})

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

watch(() => values.name, (name: string) => {
  if (name !== undefined) {
    setFieldValue('slug', deriveSlug(name))
  }
})

watch(() => values.key, (key: string) => {
  if (key !== undefined) {
    const uppercased = key.toUpperCase().replace(/[^A-Z]/g, '')
    if (uppercased !== key) {
      setFieldValue('key', uppercased)
    }
  }
})

const { $api } = useApi()

const onSubmit = handleSubmit(async (formValues) => {
  try {
    await $api.post('/projects', formValues as Record<string, unknown>)
    toast.success(t('projects.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
})
</script>
