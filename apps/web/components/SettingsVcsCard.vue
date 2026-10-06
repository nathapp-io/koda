<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface VcsConnection {
  provider: string
  repoOwner: string
  repoName: string
  syncMode: 'off' | 'polling' | 'webhook'
  pollingIntervalMs: number
  allowedAuthors: string[]
}

interface VcsConnectionWithSecret extends VcsConnection {
  webhookSecret?: string
}

interface SyncResult {
  syncType: string
  issuesSynced: number
  issuesSkipped: number
  tickets: Array<{ ref: string; title: string }>
}

const props = defineProps<{
  connection: VcsConnection | null
}>()

const emit = defineEmits<{
  (e: 'changed'): void
  (e: 'revealed', secret: string): void
}>()

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const existingConnection = computed(() => props.connection)

// Form validation schema
const formSchema = toTypedSchema(z.object({
  provider: z.string().min(1, t('vcs.validation.providerRequired')),
  owner: z.string().min(1, t('vcs.validation.ownerRequired')),
  repo: z.string().min(1, t('vcs.validation.repoRequired')),
  token: z.string().optional(),
  syncMode: z.enum(['off', 'polling', 'webhook']),
  pollingInterval: z.coerce.number().min(60000, t('vcs.validation.pollingIntervalMin')).max(86400000, t('vcs.validation.pollingIntervalMax')).optional(),
  authors: z.string().optional(),
}))

const { handleSubmit, setValues, isSubmitting, values } = useForm({
  validationSchema: formSchema,
  initialValues: {
    provider: '',
    owner: '',
    repo: '',
    token: '',
    syncMode: 'off',
    pollingInterval: 600000,
    authors: '',
  },
})

// Pre-fill form with existing connection data
watch(existingConnection, (connection) => {
  if (connection) {
    setValues({
      provider: connection.provider || '',
      owner: connection.repoOwner || '',
      repo: connection.repoName || '',
      token: '',
      syncMode: connection.syncMode || 'off',
      pollingInterval: connection.pollingIntervalMs || 600000,
      authors: connection.allowedAuthors?.join(', ') || '',
    })
  }
}, { immediate: true })

// Form submission handler
const onSubmit = handleSubmit(async (values) => {
  try {
    if (!existingConnection.value && !values.token) {
      toast.error(t('vcs.validation.tokenRequired'))
      return
    }

    const payload = {
      provider: values.provider,
      repoOwner: values.owner,
      repoName: values.repo,
      ...(values.token ? { token: values.token } : {}),
      syncMode: values.syncMode,
      pollingIntervalMs: values.syncMode === 'polling' && values.pollingInterval !== undefined && !Number.isNaN(values.pollingInterval)
        ? Number(values.pollingInterval)
        : undefined,
      allowedAuthors: values.authors
        ? values.authors.split(',').map(author => author.trim()).filter(Boolean)
        : undefined,
    }

    let saved: VcsConnectionWithSecret | undefined
    if (existingConnection.value) {
      saved = await $api.patch(apiPath`/projects/${slug}/vcs`, payload) as VcsConnectionWithSecret
    } else {
      saved = await $api.post(apiPath`/projects/${slug}/vcs`, payload) as VcsConnectionWithSecret
    }
    // GitLab is polling-only (the API refuses webhook mode), so its stored secret
    // is not usable and is not surfaced.
    if (saved?.provider !== 'gitlab' && saved?.webhookSecret) emit('revealed', saved.webhookSecret)

    toast.success(t('vcs.toast.connectionSuccess'))
    emit('changed')
  } catch (err) {
    toast.error(extractApiError(err))
  }
})

const rotatingSecret = ref(false)
async function rotateSecret() {
  if (!window.confirm(t('vcs.secret.rotateConfirm'))) return
  rotatingSecret.value = true
  try {
    const result = await $api.post<{ webhookSecret: string }>(apiPath`/projects/${slug}/vcs/webhook-secret/rotate`)
    if (result.webhookSecret) emit('revealed', result.webhookSecret)
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    rotatingSecret.value = false
  }
}

// Test connection handler
const testingConnection = ref(false)
async function testConnection() {
  testingConnection.value = true
  try {
    await $api.post(apiPath`/projects/${slug}/vcs/test`)
    toast.success(t('vcs.toast.connectionTestSuccess'))
  } catch (err) {
    const errorMsg = extractApiError(err)
    toast.error(t('vcs.toast.connectionTestFailed', { error: errorMsg }))
  } finally {
    testingConnection.value = false
  }
}

// Sync now handler
const syncing = ref(false)
async function syncNow() {
  syncing.value = true
  try {
    const result = await $api.post<SyncResult>(apiPath`/projects/${slug}/vcs/sync`)
    toast.success(t('vcs.toast.syncComplete', {
      created: result.issuesSynced,
      updated: 0,
      skipped: result.issuesSkipped,
    }))
  } catch (err) {
    const errorMsg = extractApiError(err)
    toast.error(t('vcs.toast.syncFailed', { error: errorMsg }))
  } finally {
    syncing.value = false
  }
}

const syncingPr = ref(false)
async function syncPrStatus() {
  syncingPr.value = true
  try {
    const result = await $api.post<{ updated: number }>(apiPath`/projects/${slug}/vcs/sync-pr`)
    toast.success(t('vcs.toast.syncPrComplete', { updated: result.updated }))
  } catch (err) {
    const errorMsg = extractApiError(err)
    toast.error(t('vcs.toast.syncPrFailed', { error: errorMsg }))
  } finally {
    syncingPr.value = false
  }
}

async function disconnect() {
  try {
    await $api.delete(apiPath`/projects/${slug}/vcs`)
    toast.success(t('vcs.toast.disconnectSuccess'))
    emit('revealed', '')
    emit('changed')
  } catch {
    toast.error(t('vcs.toast.disconnectFailed'))
  }
}
</script>

<template>
  <form @submit="onSubmit" class="space-y-6">
    <!-- Provider Field -->
    <FormField name="provider" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.provider') }}</FormLabel>
      <Select v-bind="componentField">
        <FormControl>
          <SelectTrigger data-testid="provider">
            <SelectValue :placeholder="t('vcs.form.providerPlaceholder')" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="github">{{ t('vcs.form.providerGithub') }}</SelectItem>
          <SelectItem value="gitlab">{{ t('vcs.form.providerGitlab') }}</SelectItem>
        </SelectContent>
      </Select>
      <FormMessage />
    </FormField>

    <!-- Owner Field -->
    <FormField name="owner" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.owner') }}</FormLabel>
      <Input data-testid="owner" :placeholder="t('vcs.form.ownerPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Repo Field -->
    <FormField name="repo" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.repo') }}</FormLabel>
      <Input data-testid="repo" :placeholder="t('vcs.form.repoPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Token Field -->
    <FormField name="token" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.token') }}</FormLabel>
      <Input data-testid="token" :placeholder="t('vcs.form.tokenPlaceholder')" v-bind="componentField" type="password" />
      <FormMessage />
    </FormField>

    <!-- Sync Mode Field (RadioGroup) -->
    <FormField name="syncMode" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.syncMode') }}</FormLabel>
      <RadioGroup data-testid="syncMode" v-bind="componentField" class="space-y-2">
        <div class="flex items-center space-x-2">
          <RadioGroupItem value="off" />
          <label>{{ t('vcs.form.syncModeOff') }}</label>
        </div>
        <div class="flex items-center space-x-2">
          <RadioGroupItem value="polling" />
          <label>{{ t('vcs.form.syncModePolling') }}</label>
        </div>
        <div class="flex items-center space-x-2">
          <RadioGroupItem value="webhook" :disabled="values.provider === 'gitlab'" />
          <label>{{ t('vcs.form.syncModeWebhook') }}</label>
        </div>
      </RadioGroup>
      <p v-if="values.provider === 'gitlab'" class="text-xs text-muted-foreground">{{ t('vcs.form.gitlabPollingOnly') }}</p>
      <FormMessage />
    </FormField>

    <!-- Polling Interval Field -->
    <FormField name="pollingInterval" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.pollingInterval') }}</FormLabel>
      <Input data-testid="pollingInterval" :placeholder="t('vcs.form.pollingIntervalPlaceholder')" v-bind="componentField" type="number" />
      <FormMessage />
    </FormField>

    <!-- Authors Field -->
    <FormField name="authors" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.authors') }}</FormLabel>
      <Input data-testid="authors" :placeholder="t('vcs.form.authorsPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Form Actions -->
    <div class="flex flex-wrap gap-3">
      <Button type="submit" :disabled="isSubmitting">
        {{ isSubmitting ? t('common.loading') : (existingConnection ? t('vcs.form.update') : t('vcs.form.submit')) }}
      </Button>

      <Button
        type="button"
        variant="outline"
        @click="testConnection"
        :disabled="testingConnection"
      >
        {{ testingConnection ? t('vcs.form.testing') : t('vcs.form.testConnection') }}
      </Button>

      <Button
        type="button"
        variant="outline"
        @click="syncNow"
        :disabled="syncing"
      >
        {{ syncing ? t('vcs.form.syncing') : t('vcs.form.syncNow') }}
      </Button>

      <Button
        type="button"
        variant="outline"
        @click="syncPrStatus"
        :disabled="syncingPr"
      >
        {{ syncingPr ? t('common.loading') : t('vcs.form.syncPr') }}
      </Button>

      <Button
        v-if="existingConnection"
        type="button"
        variant="outline"
        :disabled="rotatingSecret"
        @click="rotateSecret"
      >
        {{ rotatingSecret ? t('common.loading') : t('vcs.secret.rotate') }}
      </Button>

      <Button
        v-if="existingConnection"
        type="button"
        variant="destructive"
        @click="disconnect"
      >
        {{ t('vcs.form.disconnect') }}
      </Button>
    </div>
  </form>
</template>
