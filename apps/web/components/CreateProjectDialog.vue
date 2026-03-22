<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>Create Project</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="name" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input placeholder="My Awesome Project" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="slug" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Slug</FormLabel>
            <FormControl>
              <Input placeholder="my-awesome-project" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="key" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Key</FormLabel>
            <FormControl>
              <Input placeholder="MAP" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? 'Creating...' : 'Create Project' }}
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

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const formSchema = toTypedSchema(
  z.object({
    name: z.string().min(1, 'Name is required'),
    slug: z.string().min(1, 'Slug is required').regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
    key: z
      .string()
      .min(2, 'Key must be at least 2 characters')
      .max(6, 'Key must be at most 6 characters')
      .regex(/^[A-Z]+$/, 'Key must contain only uppercase letters A-Z'),
  }) as any
)

const { handleSubmit, setFieldValue, isSubmitting, values } = useForm({
  validationSchema: formSchema,
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
    toast.success('Project created successfully')
    emit('created')
    emit('update:open', false)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create project'
    toast.error(message)
  }
})
</script>
