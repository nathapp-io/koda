<template>
  <form @submit="onSubmit" class="space-y-6">
    <!-- Provider Field -->
    <FormField name="provider" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.provider') }}</FormLabel>
      <Select v-bind="componentField">
        <FormControl>
          <SelectTrigger>
            <SelectValue :placeholder="t('vcs.form.providerPlaceholder')" />
          </SelectTrigger>
        </FormControl>
        <SelectContent>
          <SelectItem value="github">GitHub</SelectItem>
          <SelectItem value="gitlab">GitLab</SelectItem>
          <SelectItem value="bitbucket">Bitbucket</SelectItem>
        </SelectContent>
      </Select>
      <FormMessage />
    </FormField>

    <!-- Owner Field -->
    <FormField name="owner" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.owner') }}</FormLabel>
      <Input :placeholder="t('vcs.form.ownerPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Repo Field -->
    <FormField name="repo" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.repo') }}</FormLabel>
      <Input :placeholder="t('vcs.form.repoPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Token Field -->
    <FormField name="token" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.token') }}</FormLabel>
      <Input :placeholder="t('vcs.form.tokenPlaceholder')" v-bind="componentField" type="password" />
      <FormMessage />
    </FormField>

    <!-- Sync Mode Field (RadioGroup) -->
    <FormField name="syncMode" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.syncMode') }}</FormLabel>
      <RadioGroup v-bind="componentField" class="space-y-2">
        <div class="flex items-center space-x-2">
          <RadioGroupItem value="polling" />
          <label>{{ t('vcs.form.syncModePolling') }}</label>
        </div>
        <div class="flex items-center space-x-2">
          <RadioGroupItem value="webhook" />
          <label>{{ t('vcs.form.syncModeWebhook') }}</label>
        </div>
      </RadioGroup>
      <FormMessage />
    </FormField>

    <!-- Polling Interval Field -->
    <FormField name="pollingInterval" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.pollingInterval') }}</FormLabel>
      <Input :placeholder="t('vcs.form.pollingIntervalPlaceholder')" v-bind="componentField" type="number" />
      <FormMessage />
    </FormField>

    <!-- Authors Field -->
    <FormField name="authors" v-slot="{ componentField }">
      <FormLabel>{{ t('vcs.form.authors') }}</FormLabel>
      <Input :placeholder="t('vcs.form.authorsPlaceholder')" v-bind="componentField" type="text" />
      <FormMessage />
    </FormField>

    <!-- Form Actions -->
    <div class="flex flex-wrap gap-3">
      <Button type="submit" :disabled="isSubmitting">
        {{ isSubmitting ? t('common.loading') : (hasExisting ? t('vcs.form.update') : t('vcs.form.submit')) }}
      </Button>

      <Button
        type="button"
        variant="outline"
        @click="handleTestConnection"
        :disabled="testingConnection"
      >
        {{ testingConnection ? t('vcs.form.testing') : t('vcs.form.testConnection') }}
      </Button>

      <Button
        type="button"
        variant="outline"
        @click="handleSyncNow"
        :disabled="syncing"
      >
        {{ syncing ? t('vcs.form.syncing') : t('vcs.form.syncNow') }}
      </Button>

      <Button
        v-if="hasExisting"
        type="button"
        variant="destructive"
      >
        {{ t('vcs.form.disconnect') }}
      </Button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { useI18n } from 'vue-i18n'
import { useApi, extractApiError } from '~/composables/useApi'
import { useAppToast } from '~/composables/useAppToast'

interface VcsConnection {
  provider: string
  owner: string
  repo: string
  token?: string
  syncMode: string
  pollingInterval: number
  authors?: string
}

interface SyncResult {
  created: number
  updated: number
  skipped: number
}

const { t } = useI18n()
const { $api } = useApi()
const toast = useAppToast()

const props = defineProps<{
  slug: string
  existingConnection?: VcsConnection | null
}>()

const emit = defineEmits<{
  submit: [connection: VcsConnection]
  testSuccess: []
  testError: [error: string]
  syncComplete: [result: SyncResult]
  syncError: [error: string]
}>()

const hasExisting = computed(() => !!props.existingConnection)

// Form validation schema
const formSchema = toTypedSchema(z.object({
  provider: z.string().min(1, t('vcs.validation.providerRequired')),
  owner: z.string().min(1, t('vcs.validation.ownerRequired')),
  repo: z.string().min(1, t('vcs.validation.repoRequired')),
  token: z.string().min(1, t('vcs.validation.tokenRequired')),
  syncMode: z.enum(['polling', 'webhook']),
  pollingInterval: z.number().min(60, t('vcs.validation.pollingIntervalMin')).max(86400, t('vcs.validation.pollingIntervalMax')).optional(),
  authors: z.string().optional(),
}))

const { handleSubmit, setValues, isSubmitting } = useForm({
  validationSchema: formSchema,
  initialValues: {
    provider: props.existingConnection?.provider || '',
    owner: props.existingConnection?.owner || '',
    repo: props.existingConnection?.repo || '',
    token: '',
    syncMode: props.existingConnection?.syncMode || 'polling',
    pollingInterval: props.existingConnection?.pollingInterval || 300,
    authors: props.existingConnection?.authors || '',
  },
})

// Update form values when existing connection changes
watch(() => props.existingConnection, (connection) => {
  if (connection) {
    setValues({
      provider: connection.provider || '',
      owner: connection.owner || '',
      repo: connection.repo || '',
      token: '',
      syncMode: connection.syncMode || 'polling',
      pollingInterval: connection.pollingInterval || 300,
      authors: connection.authors || '',
    })
  }
}, { immediate: true })

// Form submission handler
const onSubmit = handleSubmit(async (values) => {
  try {
    const payload = {
      provider: values.provider,
      owner: values.owner,
      repo: values.repo,
      token: values.token,
      syncMode: values.syncMode,
      pollingInterval: values.syncMode === 'polling' ? values.pollingInterval : undefined,
      authors: values.authors || undefined,
    }

    if (hasExisting.value) {
      await $api.patch(`/projects/${props.slug}/vcs`, payload)
    } else {
      await $api.post(`/projects/${props.slug}/vcs`, payload)
    }

    toast.success(t('vcs.toast.connectionSuccess'))
    emit('submit', payload as VcsConnection)
  } catch (err) {
    toast.error(extractApiError(err))
  }
})

// Test connection handler
const testingConnection = ref(false)
async function handleTestConnection() {
  testingConnection.value = true
  try {
    await $api.post(`/projects/${props.slug}/vcs/test`)
    toast.success(t('vcs.toast.connectionTestSuccess'))
    emit('testSuccess')
  } catch (err) {
    const errorMsg = extractApiError(err)
    toast.error(t('vcs.toast.connectionTestFailed', { error: errorMsg }))
    emit('testError', errorMsg)
  } finally {
    testingConnection.value = false
  }
}

// Sync now handler
const syncing = ref(false)
async function handleSyncNow() {
  syncing.value = true
  try {
    const result = await $api.post<SyncResult>(`/projects/${props.slug}/vcs/sync`)
    toast.success(t('vcs.toast.syncComplete', {
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    }))
    emit('syncComplete', result)
  } catch (err) {
    const errorMsg = extractApiError(err)
    toast.error(t('vcs.toast.syncFailed', { error: errorMsg }))
    emit('syncError', errorMsg)
  } finally {
    syncing.value = false
  }
}
</script>
