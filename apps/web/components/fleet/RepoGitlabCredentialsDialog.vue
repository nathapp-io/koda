<template>
  <Button type="button" variant="outline" size="sm" data-testid="fleet-repo-rotate" @click="open = true">
    {{ t('fleet.repos.gitlab.rotate') }}
  </Button>

  <Dialog :open="open" @update:open="open = $event">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ t('fleet.repos.gitlab.dialog.title') }}</DialogTitle>
        <DialogDescription>{{ t('fleet.repos.gitlab.dialog.hint') }}</DialogDescription>
      </DialogHeader>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="readToken">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.gitlab.dialog.readToken') }}</FormLabel>
            <FormControl><Input v-bind="componentField" type="password" autocomplete="off" :disabled="!allowed || saving" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="writeToken">
          <FormItem>
            <FormLabel>{{ t('fleet.repos.gitlab.dialog.writeToken') }}</FormLabel>
            <FormControl><Input v-bind="componentField" type="password" autocomplete="off" :disabled="!allowed || saving" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="confirmBotAccount">
          <FormItem>
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                class="h-4 w-4"
                data-testid="fleet-repo-rotate-bot"
                :disabled="!allowed || saving"
                :checked="Boolean(componentField.modelValue)"
                @change="componentField['onUpdate:modelValue'](($event.target as HTMLInputElement).checked)"
              />
              <span>{{ t('fleet.repos.gitlab.dialog.confirmBot') }}</span>
            </label>
          </FormItem>
        </FormField>

        <p v-if="pending" role="status" class="text-sm text-muted-foreground">{{ t('fleet.repos.gitlab.dialog.pending') }}</p>
        <p v-if="error" role="alert" class="text-sm text-status-rejected">{{ error }}</p>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" :disabled="saving" @click="open = false">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="!allowed || saving">
            {{ saving ? t('fleet.repos.gitlab.dialog.saving') : t('fleet.repos.gitlab.dialog.save') }}
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
import { useFleetRepos } from '~/composables/useFleetRepos'
import type { FleetRepo, FleetGitlabCredentialsBody } from '~/lib/fleet-types'

const props = defineProps<{ repo: FleetRepo }>()

const emit = defineEmits<{
  (e: 'saved', repo: FleetRepo): void
}>()

const { t } = useI18n()
// RepoFixUnprotected's pattern: the gate only disables the control, an API refusal is still
// surfaced through extractApiError. The page hides the trigger entirely without the key.
const { permissions } = useGlobalPermissions()
const allowed = computed(() => permissions.value.has('fleet.repo.credentials.update'))
const { rotateGitlabCredentials } = useFleetRepos()

const open = ref(false)
const saving = ref(false)
const pending = ref(false)
const error = ref('')

const formSchema = toTypedSchema(z.object({
  readToken: z.string(),
  writeToken: z.string(),
  confirmBotAccount: z.boolean(),
}).superRefine((values, ctx) => {
  // The API answers fleet.repoGitlabCredentialsEmpty for a body naming neither token; the client
  // refuses the same case before it spends the request.
  if (!values.readToken.trim() && !values.writeToken.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['readToken'], message: t('fleet.repos.gitlab.tokensRequired') })
  }
}))

const { handleSubmit, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { readToken: '', writeToken: '', confirmBotAccount: false },
})

// A reopening dialog must not show the previous rotation's draft (and never a raw token).
watch(open, (opened) => {
  if (opened) {
    pending.value = false
    error.value = ''
    resetForm()
  }
})

const onSubmit = handleSubmit(async (values) => {
  saving.value = true
  pending.value = false
  error.value = ''
  try {
    const body: FleetGitlabCredentialsBody = {}
    // Only what the admin supplied is sent: an absent token stays as stored, and the confirmation
    // is only meaningful when it turns the human-account warning off.
    if (values.readToken.trim()) body.readToken = values.readToken.trim()
    if (values.writeToken.trim()) body.writeToken = values.writeToken.trim()
    if (values.confirmBotAccount === true) body.confirmBotAccount = true
    const result = await rotateGitlabCredentials(props.repo.id, body)
    if ('permissionKey' in result) {
      pending.value = true
      return
    }
    emit('saved', result)
    open.value = false
  } catch (err: unknown) {
    error.value = extractApiError(err)
  } finally {
    saving.value = false
  }
})
</script>
