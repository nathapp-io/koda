<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('skills.form.title') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('skills.form.hint') }}</p>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="gitUrl">
          <FormItem>
            <FormLabel>{{ t('skills.form.gitUrl') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="skill-source-git-url" :placeholder="t('skills.form.gitUrlPlaceholder')" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="ref">
          <FormItem>
            <FormLabel>{{ t('skills.form.ref') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="skill-source-ref" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="path">
          <FormItem>
            <FormLabel>{{ t('skills.form.path') }}</FormLabel>
            <FormControl><Input v-bind="componentField" data-testid="skill-source-path" :placeholder="t('skills.form.pathPlaceholder')" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('skills.form.submitting') : t('skills.form.submit') }}
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
import type { SkillSourceDto } from '~/composables/useSkillCatalog'

const props = defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created', source: SkillSourceDto): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create } = useSkillCatalog()

/**
 * Mirrors the API's parseGitHubUrl (apps/api/src/skills/github-url.ts) so a URL the form accepts is one
 * the API accepts: case-insensitive host, an optional trailing `.git` and `/`, owner and repo of
 * [a-z0-9_.-] up to 100 characters, and never `.`, `..` or `.git`. The API stays the authority.
 */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
const GITHUB_SEGMENT = /^[a-z0-9_.-]{1,100}$/i
const DOT_SEGMENTS = new Set(['.', '..', '.git'])

function isGitHubRepoUrl(value: string): boolean {
  const match = GITHUB_REPO_URL.exec(value)
  if (!match) return false
  return [match[1], match[2]].every((segment) => GITHUB_SEGMENT.test(segment) && !DOT_SEGMENTS.has(segment.toLowerCase()))
}

const formSchema = toTypedSchema(z.object({
  gitUrl: z.string().trim().refine(isGitHubRepoUrl, t('skills.form.gitUrlInvalid')),
  ref: z.string().trim().min(1, t('skills.form.refRequired')),
  path: z.string().trim(),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { gitUrl: '', ref: '', path: '' },
})

// Closing discards the draft, like AddRepoDialog: a cancelled half-typed source must not come back.
watch(() => props.open, (open) => {
  if (!open) resetForm()
})

// A 409 (already registered) arrives as the API's translated message and is shown as is.
const onSubmit = handleSubmit(async (values) => {
  try {
    const source = await create(values)
    emit('created', source)
    emit('update:open', false)
    resetForm()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
