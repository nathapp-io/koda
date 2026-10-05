<template>
  <div class="space-y-8">
    <PageHeader :title="t('nav.dashboard')" :subtitle="t('home.subtitle')">
      <template #actions>
        <Button @click="showCreateDialog = true">
          {{ t('projects.newProject') }}
        </Button>
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <template v-else>
      <EmptyState
        v-if="!home || home.projects.length === 0"
        :message="t('projects.noProjectsHint')"
        :icon="FolderPlus"
      >
        <Button class="mt-4" @click="showCreateDialog = true">{{ t('projects.newProject') }}</Button>
      </EmptyState>

      <template v-else>
        <section class="space-y-3" data-testid="home-needs-you">
          <h2 class="text-lg font-semibold">{{ t('home.needsYou') }}</h2>
          <HomeNeedsYou :needs-you="home.needsYou" :now="now" />
        </section>

        <section class="space-y-3" data-testid="home-projects">
          <h2 class="text-lg font-semibold">{{ t('home.projects.title') }}</h2>
          <HomeProjectList :projects="home.projects" />
        </section>

        <section class="space-y-3" data-testid="home-activity">
          <h2 class="text-lg font-semibold">{{ t('home.activity.title') }}</h2>
          <HomeActivityList :activity="home.activity" :now="now" />
        </section>
      </template>
    </template>

    <CreateProjectDialog
      v-if="showCreateDialog"
      :open="showCreateDialog"
      @update:open="showCreateDialog = $event"
      @created="onProjectCreated"
    />
  </div>
</template>

<script setup lang="ts">
import { FolderPlus } from 'lucide-vue-next'
import type { HomeSnapshot } from '~/lib/home-types'

definePageMeta({ layout: 'default' })

const { t } = useI18n()

const showCreateDialog = ref(false)

const { $api } = useApi()

const { data: home, pending, error, refresh } = useAsyncData('home', () =>
  $api.get('/home') as Promise<HomeSnapshot>,
)

// Coarse clock for the relative ages; ages read "2m ago", so a 30 s tick is plenty.
const now = ref(new Date())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => {
    now.value = new Date()
  }, 30_000)
})
onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
})

function onProjectCreated() {
  showCreateDialog.value = false
  refresh()
}
</script>
