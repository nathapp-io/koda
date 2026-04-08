<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { ApiError, extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'default' })

interface VcsConnection {
  provider: string
  repoOwner: string
  repoName: string
  syncMode: 'off' | 'polling' | 'webhook'
  pollingIntervalMs: number
  allowedAuthors: string[]
}

interface SyncResult {
  syncType: string
  issuesSynced: number
  issuesSkipped: number
  tickets: Array<{ ref: string; title: string }>
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

// Fetch existing VCS connection
const { data: connectionData, pending: loadingConnection, error: connectionError, refresh: refreshConnection } = useAsyncData(
  `vcs-connection-${slug}`,
  async () => {
    try {
      return await $api.get(`/projects/${slug}/vcs`) as VcsConnection
    } catch (error) {
      const fetchStatus = (error as { response?: { status?: number } }).response?.status
      const appCode = error instanceof ApiError ? error.code : undefined
      if (fetchStatus === 404 || appCode === 404) {
        return null
      }
      throw error
    }
  },
  { immediate: true }
)

const existingConnection = computed(() => connectionData.value)

// Form validation schema
const formSchema = toTypedSchema(z.object({
  provider: z.string().min(1, t('vcs.validation.providerRequired')),
  owner: z.string().min(1, t('vcs.validation.ownerRequired')),
  repo: z.string().min(1, t('vcs.validation.repoRequired')),
  token: z.string().optional(),
  syncMode: z.enum(['off', 'polling', 'webhook']),
  pollingInterval: z.number().min(60000, t('vcs.validation.pollingIntervalMin')).max(86400000, t('vcs.validation.pollingIntervalMax')).optional(),
  authors: z.string().optional(),
}))

const { handleSubmit, setValues, isSubmitting } = useForm({
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
      pollingIntervalMs: values.syncMode === 'polling' ? values.pollingInterval : undefined,
      allowedAuthors: values.authors
        ? values.authors.split(',').map(author => author.trim()).filter(Boolean)
        : undefined,
    }

    if (existingConnection.value) {
      await $api.patch(`/projects/${slug}/vcs`, payload)
    } else {
      await $api.post(`/projects/${slug}/vcs`, payload)
    }

    toast.success(t('vcs.toast.connectionSuccess'))
    await refreshConnection()
  } catch (err) {
    toast.error(extractApiError(err))
  }
})

// Test connection handler
const testingConnection = ref(false)
async function testConnection() {
  testingConnection.value = true
  try {
    await $api.post(`/projects/${slug}/vcs/test`)
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
    const result = await $api.post<SyncResult>(`/projects/${slug}/vcs/sync`)
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

async function disconnect() {
  try {
    await $api.delete(`/projects/${slug}/vcs`)
    toast.success(t('vcs.toast.disconnectSuccess'))
    await refreshConnection()
  } catch (err) {
    toast.error(t('vcs.toast.disconnectFailed'))
  }
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('vcs.title')" />

    <!-- Tabs Container -->
    <Tabs default-value="vcs" class="w-full">
      <TabsList class="grid w-full max-w-md grid-cols-1">
        <TabsTrigger value="vcs">
          {{ t('vcs.tab') }}
        </TabsTrigger>
      </TabsList>

      <!-- VCS Integration Tab -->
      <TabsContent value="vcs" class="space-y-4">
        <div class="rounded-md border border-border p-6 space-y-6">
          <div>
            <h2 class="text-lg font-semibold">{{ t('vcs.title') }}</h2>
            <p class="text-sm text-muted-foreground">{{ t('vcs.description') }}</p>
          </div>

          <!-- Loading and Error States -->
          <LoadingState v-if="loadingConnection" />
          <ErrorState v-else-if="connectionError" @retry="refreshConnection()" />

          <!-- VCS Form -->
          <form v-else @submit="onSubmit" class="space-y-6">
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
                  <RadioGroupItem value="webhook" />
                  <label>{{ t('vcs.form.syncModeWebhook') }}</label>
                </div>
              </RadioGroup>
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
                v-if="existingConnection"
                type="button"
                variant="destructive"
                @click="disconnect"
              >
                {{ t('vcs.form.disconnect') }}
              </Button>
            </div>
          </form>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
