<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-3xl font-bold tracking-tight">Projects</h1>
        <p class="mt-2 text-muted-foreground">
          View and manage your development projects
        </p>
      </div>
      <Button @click="showCreateDialog = true">
        New Project
      </Button>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      <template v-if="projects && projects.length > 0">
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
              <Button variant="outline" class="w-full">View Board</Button>
            </NuxtLink>
          </CardFooter>
        </Card>
      </template>
      <template v-else>
        <div class="col-span-full flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-background/50 py-12">
          <h3 class="mt-4 text-lg font-medium">No projects yet</h3>
          <p class="mt-1 text-sm text-muted-foreground">
            Create your first project to get started
          </p>
        </div>
      </template>
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

interface Project {
  id: number
  name: string
  key: string
  slug: string
  description?: string
}

const showCreateDialog = ref(false)

const { $api } = useApi()

const { data: projectsData, refresh } = useAsyncData('projects', () =>
  $api.get('/projects') as Promise<Project[]>
)

const projects = computed(() => projectsData.value ?? [])

function onProjectCreated() {
  showCreateDialog.value = false
  refresh()
}
</script>
