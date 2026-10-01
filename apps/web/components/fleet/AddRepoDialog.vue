<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.repos.form.title') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('fleet.repos.form.hint') }}</p>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="projectSlug">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.project') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="projectOptions" :placeholder="t('fleet.repos.form.projectPlaceholder')" testid="fleet-repo-project" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="provider">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.provider') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="providerOptions" testid="fleet-repo-provider" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="owner">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.owner') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('fleet.repos.form.submitting') : t('fleet.repos.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { REPO_NAME_PATTERN, REPO_OWNER_PATTERN } from '~/lib/fleet-validation'
import type { ProjectOption } from '~/composables/useFleetRepos'
import type { FleetRepo } from '~/lib/fleet-types'

const props = defineProps<{ open: boolean; projects: ProjectOption[] }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created', repo: FleetRepo): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { create } = useFleetRepos()

const projectOptions = computed(() => props.projects.map((p) => ({ value: p.slug, label: `${p.name} (${p.slug})` })))
const providerOptions = computed(() => [
  { value: 'github', label: t('fleet.repos.provider.github') },
  { value: 'gitlab', label: t('fleet.repos.provider.gitlab') },
])

const formSchema = toTypedSchema(z.object({
  projectSlug: z.string().min(1, t('fleet.validation.required')),
  provider: z.enum(['github', 'gitlab']),
  owner: z.string().trim().regex(REPO_OWNER_PATTERN, t('fleet.validation.ownerInvalid')),
  name: z.string().trim().regex(REPO_NAME_PATTERN, t('fleet.validation.nameInvalid')),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { projectSlug: '', provider: 'github' as const, owner: '', name: '' },
})

// Closing discards the draft, like EnrollmentTokenDialog: an admin who cancels must not find their
// half-typed owner and the project they picked still filled in next time.
watch(() => props.open, (open) => {
  if (!open) resetForm()
})

// The API runs the forge check before saving. A 409 (already registered) or a 422 arrives as the
// API's translated message; a 422's message embeds the check reason as its raw code, which stays
// raw here: parsing it out of the message is banned (.nax/rules/common.md, structured codes only).
const onSubmit = handleSubmit(async (values) => {
  try {
    const repo = await create(values)
    toast.success(t('fleet.repos.toast.added'))
    emit('created', repo)
    emit('update:open', false)
    resetForm()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
