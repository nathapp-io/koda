<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>Create Ticket</DialogTitle>
      </DialogHeader>

      <form @submit="onSubmit" class="space-y-4">
        <FormField name="title" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Title</FormLabel>
            <FormControl>
              <Input placeholder="Short description of the issue" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="type" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Type</FormLabel>
            <Select v-bind="componentField">
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="BUG">Bug</SelectItem>
                <SelectItem value="ENHANCEMENT">Enhancement</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="priority" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Priority</FormLabel>
            <Select v-bind="componentField">
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="LOW">Low</SelectItem>
                <SelectItem value="MEDIUM">Medium</SelectItem>
                <SelectItem value="HIGH">High</SelectItem>
                <SelectItem value="CRITICAL">Critical</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField name="description" v-slot="{ componentField }">
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Textarea placeholder="Optional details about the ticket" v-bind="componentField" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? 'Creating...' : 'Create Ticket' }}
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

const formSchema = toTypedSchema(
  z.object({
    title: z.string({ required_error: 'Title is required' }).min(3, 'Title must be at least 3 characters'),
    type: z.preprocess(
      (val) => (val === '' ? undefined : val),
      z.enum(['BUG', 'ENHANCEMENT'], { required_error: 'Please select a type' })
    ),
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
    toast.success('Ticket created successfully')
    emit('created')
    emit('update:open', false)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create ticket'
    toast.error(message)
  }
})
</script>
