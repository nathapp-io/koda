<script setup lang="ts">
import { computed } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

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

const emit = defineEmits<{
  (e: 'comment-added'): void
}>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const commentsEndpoint = `/projects/${props.projectSlug}/tickets/${props.ticketRef}/comments`

const { data, pending, error, refresh: refreshComments } = useAsyncData<Comment[]>(
  `comments-${props.projectSlug}-${props.ticketRef}`,
  () => $api.get(commentsEndpoint) as Promise<Comment[]>
)

const comments = computed(() => data.value ?? [])

const typePillClass: Record<Comment['type'], string> = {
  VERIFICATION: 'bg-blue-100 text-blue-800',
  FIX_REPORT: 'bg-orange-100 text-orange-800',
  REVIEW: 'bg-green-100 text-green-800',
  GENERAL: 'bg-muted text-muted-foreground',
}

const commentSchema = toTypedSchema(
  z.object({
    body: z.string().min(1, t('comments.validation.bodyRequired')),
    type: z.enum(['GENERAL', 'VERIFICATION', 'FIX_REPORT', 'REVIEW']),
  })
)

const { handleSubmit, resetForm } = useForm({
  validationSchema: commentSchema,
  initialValues: {
    body: '',
    type: 'GENERAL',
  },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await $api.post(commentsEndpoint, {
      body: values.body,
      type: values.type,
    })
    await refreshComments()
    resetForm()
    emit('comment-added')
    toast.success(t('comments.toast.added'))
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Comments list -->
    <div v-if="pending" class="text-muted-foreground text-sm">{{ t('common.loadingComments') }}</div>
    <div v-else-if="error" class="text-destructive text-sm">{{ t('common.failedLoadComments') }}</div>
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
            {{ t(`comments.types.${comment.type}`) }}
          </span>
          <span class="text-xs text-muted-foreground">{{ comment.createdAt }}</span>
        </div>
        <p class="text-sm whitespace-pre-wrap">{{ comment.body }}</p>
      </div>
      <p v-if="comments.length === 0" class="text-muted-foreground text-sm">{{ t('common.noCommentsYet') }}</p>
    </div>

    <!-- Add comment form -->
    <form class="space-y-4" @submit="onSubmit">
      <FormField name="body" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>{{ t('comments.label') }}</FormLabel>
          <FormControl>
            <Textarea
              :placeholder="t('comments.placeholder')"
              rows="3"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField name="type" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>{{ t('comments.type') }}</FormLabel>
          <Select v-bind="componentField">
            <FormControl>
              <SelectTrigger>
                <SelectValue :placeholder="t('comments.type')" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value="GENERAL">{{ t('comments.types.GENERAL') }}</SelectItem>
              <SelectItem value="VERIFICATION">{{ t('comments.types.VERIFICATION') }}</SelectItem>
              <SelectItem value="FIX_REPORT">{{ t('comments.types.FIX_REPORT') }}</SelectItem>
              <SelectItem value="REVIEW">{{ t('comments.types.REVIEW') }}</SelectItem>
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      </FormField>

      <Button type="submit">{{ t('comments.add') }}</Button>
    </form>
  </div>
</template>
