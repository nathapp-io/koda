<script setup lang="ts">
import { ref } from 'vue'
import { useForm } from 'vee-validate'
import * as z from 'zod'
import { toast } from 'vue-sonner'

interface Comment {
  id: string
  body: string
  type: 'GENERAL' | 'VERIFICATION' | 'FIX_REPORT' | 'REVIEW'
  createdAt: string
  [key: string]: unknown
}

const props = defineProps<{
  projectSlug: string
  ticketRef: string
}>()

const { $api } = useApi()

const commentsEndpoint = `/projects/${props.projectSlug}/tickets/${props.ticketRef}/comments`

const { data, pending, error } = await useAsyncData<Comment[]>(
  `comments-${props.projectSlug}-${props.ticketRef}`,
  () => $api.get(commentsEndpoint) as Promise<Comment[]>
)

const comments = ref([] as Comment[])
comments.value = data.value ?? []

const typePillClass: Record<Comment['type'], string> = {
  VERIFICATION: 'bg-blue-100 text-blue-800',
  FIX_REPORT: 'bg-orange-100 text-orange-800',
  REVIEW: 'bg-green-100 text-green-800',
  GENERAL: 'bg-gray-100 text-gray-800',
}

const commentSchema = z.object({
  body: z.string().min(1, 'Comment body is required'),
  type: z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW']),
})

const { handleSubmit, resetForm } = useForm({
  validationSchema: commentSchema,
  initialValues: {
    body: '',
    type: 'GENERAL',
  },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    const newComment = await $api.post(commentsEndpoint, {
      body: values.body,
      type: values.type,
    }) as Comment
    comments.value.push(newComment)
    resetForm()
    toast.success('Comment added')
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to add comment'
    toast.error(message)
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Comments list -->
    <div v-if="pending" class="text-muted-foreground text-sm">Loading comments...</div>
    <div v-else-if="error" class="text-destructive text-sm">Failed to load comments.</div>
    <div v-else class="space-y-4">
      <div
        v-for="comment in comments"
        :key="comment.id"
        class="border rounded-md p-4 space-y-2"
      >
        <div class="flex items-center gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-xs font-medium"
            :class="typePillClass[comment.type]"
          >
            {{ comment.type }}
          </span>
          <span class="text-xs text-muted-foreground">{{ comment.createdAt }}</span>
        </div>
        <p class="text-sm whitespace-pre-wrap">{{ comment.body }}</p>
      </div>
      <p v-if="comments.length === 0" class="text-muted-foreground text-sm">No comments yet.</p>
    </div>

    <!-- Add comment form -->
    <form class="space-y-4" @submit="onSubmit">
      <FormField name="body" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>Comment</FormLabel>
          <FormControl>
            <Textarea
              placeholder="Write a comment..."
              rows="3"
              v-bind="componentField"
            />
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
              <SelectItem value="GENERAL">General</SelectItem>
              <SelectItem value="VERIFICATION">Verification</SelectItem>
              <SelectItem value="FIX_REPORT">Fix Report</SelectItem>
              <SelectItem value="REVIEW">Review</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      </FormField>

      <Button type="submit">Add Comment</Button>
    </form>
  </div>
</template>
