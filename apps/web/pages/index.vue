<template>
  <div class="space-y-8">
    <PageHeader :title="t('projects.title')" :subtitle="t('projects.subtitle')">
      <template #actions>
        <Button @click="showCreateDialog = true">
          {{ t('projects.newProject') }}
        </Button>
      </template>
    </PageHeader>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <div v-else class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <template v-if="projects.length > 0">
        <Card v-for="project in projects" :key="project.id">
          <CardHeader>
            <div class="flex items-center justify-between">
              <CardTitle class="text-lg">{{ project.name }}</CardTitle>
              <Badge variant="outline">{{ project.key }}</Badge>
            </div>
            <CardDescription class="line-clamp-2 overflow-hidden">
              {{ project.description }}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <NuxtLink :to="`/${project.slug}`" class="w-full">
              <Button variant="outline" class="w-full">{{ t('common.viewBoard') }}</Button>
            </NuxtLink>
          </CardFooter>
        </Card>
      </template>
      <EmptyState v-else :message="t('projects.noProjects')" />
    </div>

    <CreateProjectDialog
      v-if="showCreateDialog"
      :open="showCreateDialog"
      @update:open="showCreateDialog = $event"
      @created="onProjectCreated"
    />
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { t } = useI18n()

interface Project {
  id: number
  name: string
  key: string
  slug: string
  description?: string
}

const showCreateDialog = ref(false)

const { $api } = useApi()

const { data: projectsData, pending, error, refresh } = useAsyncData('projects', () =>
  $api.get('/projects') as Promise<Project[]>
)

const projects = computed(() => projectsData.value ?? [])

function onProjectCreated() {
  showCreateDialog.value = false
  refresh()
}
</script>
