<script setup lang="ts">
import { ApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

definePageMeta({ layout: 'default' })

interface VcsConnection {
  provider: string
  repoOwner: string
  repoName: string
  syncMode: 'off' | 'polling' | 'webhook'
  pollingIntervalMs: number
  allowedAuthors: string[]
}

const route = useRoute()
const slug = route.params.project as string
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

interface ProjectDetails {
  id: string
  name: string
  slug: string
  key: string
  description?: string | null
}

// Fetch existing VCS connection
const { data: connectionData, pending: loadingConnection, error: connectionError, refresh: refreshConnection } = useAsyncData(
  `vcs-connection-${slug}`,
  async () => {
    try {
      return await $api.get(apiPath`/projects/${slug}/vcs`) as VcsConnection
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

// M9: the API returns the webhook secret only on create, on a legacy row
// switching to webhook mode, and on rotation. Show it until the page reloads.
// The state lives in the page (not the card) so the box survives the
// refreshConnection() loading swap instead of unmounting mid-interaction.
const revealedSecret = ref<string | null>(null)

async function copySecret() {
  if (!revealedSecret.value) return
  try {
    await navigator.clipboard.writeText(revealedSecret.value)
    toast.success(t('vcs.secret.copied'))
  } catch {
    toast.error(t('vcs.secret.copyFailed'))
  }
}

const { data: projectData, pending: loadingProject, error: projectError, refresh: refreshProject } = useAsyncData(
  `project-${slug}`,
  () => $api.get(apiPath`/projects/${slug}`) as Promise<ProjectDetails>,
)
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('vcs.title')" />

    <!-- Tabs Container -->
    <Tabs default-value="project" class="w-full">
      <TabsList class="grid w-full max-w-md grid-cols-2">
        <TabsTrigger value="project">
          {{ t('projects.title') }}
        </TabsTrigger>
        <TabsTrigger value="vcs">
          {{ t('vcs.tab') }}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="project" class="space-y-4">
        <div class="rounded-md border border-border p-6 space-y-6">
          <div>
            <h2 class="text-lg font-semibold">{{ t('projects.settings.title') }}</h2>
            <p class="text-sm text-muted-foreground">{{ t('projects.settings.description') }}</p>
          </div>

          <LoadingState v-if="loadingProject" />
          <ErrorState v-else-if="projectError" @retry="refreshProject()" />

          <SettingsProjectCard
            v-else-if="projectData"
            :project="projectData"
            @saved="refreshProject()"
          />
        </div>

        <ProjectMembersPanel :slug="slug" />
      </TabsContent>

      <!-- VCS Integration Tab -->
      <TabsContent value="vcs" class="space-y-4">
        <div class="rounded-md border border-border p-6 space-y-6">
          <div>
            <h2 class="text-lg font-semibold">{{ t('vcs.title') }}</h2>
            <p class="text-sm text-muted-foreground">{{ t('vcs.description') }}</p>
          </div>

          <LoadingState v-if="loadingConnection" />
          <ErrorState v-else-if="connectionError" @retry="refreshConnection()" />

          <div v-else class="space-y-6">
            <SettingsVcsCard
              :connection="existingConnection"
              @changed="refreshConnection()"
              @revealed="revealedSecret = $event"
            />

            <div
              v-if="revealedSecret"
              data-testid="webhook-secret"
              class="rounded-md border border-amber-500/50 bg-amber-500/10 p-4 space-y-2"
            >
              <p class="text-sm font-medium">{{ t('vcs.secret.title') }}</p>
              <p class="text-xs text-muted-foreground">{{ t('vcs.secret.onceNotice') }}</p>
              <div class="flex items-center gap-2">
                <code class="flex-1 break-all rounded bg-muted px-2 py-1 text-sm">{{ revealedSecret }}</code>
                <Button type="button" variant="outline" size="sm" @click="copySecret">
                  {{ t('vcs.secret.copy') }}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
