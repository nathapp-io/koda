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

        <!-- GitLab registration only: the API refuses these fields on a GitHub body. -->
        <template v-if="formValues.provider === 'gitlab'">
          <FormField v-slot="{ componentField }" name="host">
            <FormItem>
              <FormLabel>{{ t('fleet.repos.gitlab.host') }}</FormLabel>
              <FormControl><Input v-bind="componentField" data-testid="fleet-repo-host" :placeholder="t('fleet.repos.gitlab.hostPlaceholder')" /></FormControl>
              <p class="text-xs text-muted-foreground">{{ t('fleet.repos.gitlab.hostHint') }}</p>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField v-slot="{ componentField }" name="readToken">
            <FormItem>
              <FormLabel>{{ t('fleet.repos.gitlab.readToken') }}</FormLabel>
              <FormControl><Input v-bind="componentField" type="password" autocomplete="off" /></FormControl>
              <p class="text-xs text-muted-foreground">{{ t('fleet.repos.gitlab.readTokenHint') }}</p>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField v-slot="{ componentField }" name="writeToken">
            <FormItem>
              <FormLabel>{{ t('fleet.repos.gitlab.writeToken') }}</FormLabel>
              <FormControl><Input v-bind="componentField" type="password" autocomplete="off" /></FormControl>
              <p class="text-xs text-muted-foreground">{{ t('fleet.repos.gitlab.writeTokenHint') }}</p>
              <FormMessage />
            </FormItem>
          </FormField>

          <FormField v-slot="{ componentField }" name="confirmBotAccount">
            <FormItem>
              <label class="flex items-center gap-2 text-sm" data-testid="fleet-repo-bot-label">
                <input
                  type="checkbox"
                  class="h-4 w-4"
                  data-testid="fleet-repo-bot"
                  :checked="Boolean(componentField.modelValue)"
                  @change="componentField['onUpdate:modelValue'](($event.target as HTMLInputElement).checked)"
                />
                <span>{{ t('fleet.repos.gitlab.confirmBot') }}</span>
              </label>
            </FormItem>
          </FormField>
        </template>

        <!-- A human-account write token: the repo was created, and the admin must read why it matters
             before the dialog goes away — closing here would discard the only copy of the warning. -->
        <div v-if="humanWarning" class="space-y-3 rounded-md border border-status-review bg-muted p-3" data-testid="fleet-repo-human-warning" role="alert">
          <p class="text-sm">{{ humanWarning }}</p>
          <div class="flex justify-end">
            <Button type="button" variant="outline" @click="close">{{ t('fleet.repos.gitlab.done') }}</Button>
          </div>
        </div>

        <div v-else class="flex justify-end gap-2">
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
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { REPO_NAME_PATTERN, REPO_OWNER_PATTERN } from '~/lib/fleet-validation'
import type { ProjectOption } from '~/composables/useFleetRepos'
import type { FleetRepo, NewFleetRepo } from '~/lib/fleet-types'

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
  host: z.string().trim(),
  readToken: z.string(),
  writeToken: z.string(),
  confirmBotAccount: z.boolean(),
}).superRefine((values, ctx) => {
  // The two GitLab tokens are required only when the form registers a GitLab repo; on GitHub the
  // fields do not exist at all, so their values are never read (AC-12 sends exactly four fields).
  if (values.provider !== 'gitlab') return
  if (!values.readToken.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readToken'], message: t('fleet.repos.gitlab.tokensRequired') })
  if (!values.writeToken.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['writeToken'], message: t('fleet.repos.gitlab.tokensRequired') })
}))

const { handleSubmit, isSubmitting, resetForm, values: formValues } = useForm({
  validationSchema: formSchema,
  initialValues: { projectSlug: '', provider: 'github' as const, owner: '', name: '', host: '', readToken: '', writeToken: '', confirmBotAccount: false },
})

const humanWarning = ref('')

function close(): void {
  emit('update:open', false)
}

// Closing discards the draft, like EnrollmentTokenDialog: an admin who cancels must not find their
// half-typed owner and the project they picked still filled in next time. The token values are part
// of that draft, so a reset also keeps raw tokens out of any state that outlives the dialog.
watch(() => props.open, (open) => {
  if (!open) {
    resetForm()
    humanWarning.value = ''
  }
})

/** The API runs the forge check before saving. A 409 (already registered) or a 422 arrives as the
 * API's translated message; a 422's message embeds the check reason as its raw code, which stays
 * raw here: parsing it out of the message is banned (.nax/rules/common.md, structured codes only). */
const onSubmit = handleSubmit(async (values) => {
  // The body is built per provider: GitHub sends exactly the four original fields (AC-12), GitLab
  // adds its own — with an empty host omitted (gitlab.com is the API default) and the checkbox
  // mapped to confirmBotAccount.
  const body: NewFleetRepo = values.provider === 'gitlab'
    ? {
        projectSlug: values.projectSlug,
        provider: values.provider,
        owner: values.owner,
        name: values.name,
        readToken: values.readToken.trim(),
        writeToken: values.writeToken.trim(),
        confirmBotAccount: values.confirmBotAccount === true,
        ...(values.host.trim() ? { host: values.host.trim() } : {}),
      }
    : { projectSlug: values.projectSlug, provider: values.provider, owner: values.owner, name: values.name }
  try {
    const repo = await create(body)
    toast.success(t('fleet.repos.toast.added'))
    emit('created', repo)
    if (repo.gitlab?.warnings.includes('write_token_human')) {
      humanWarning.value = t('fleet.repos.gitlab.humanWarning', { username: repo.gitlab.writeToken.username })
    } else {
      emit('update:open', false)
      resetForm()
    }
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
