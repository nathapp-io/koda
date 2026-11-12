<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface ProjectDetails {
  id: string
  name: string
  slug: string
  key: string
  description?: string | null
}

const props = defineProps<{ project: ProjectDetails }>()
const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()
const deletingProject = ref(false)

async function deleteProject() {
  if (!window.confirm(t('projects.settings.deleteConfirm'))) return
  deletingProject.value = true
  try {
    await $api.delete(apiPath`/projects/${props.project.slug}`)
    toast.success(t('projects.settings.deleted'))
    await useRouter().push('/')
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    deletingProject.value = false
  }
}
</script>

<template>
  <section data-testid="settings-danger-zone" class="rounded-md border border-destructive/50 p-6 space-y-4">
    <div>
      <h2 class="text-lg font-semibold">{{ t('projects.settings.dangerZone.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('projects.settings.dangerZone.description') }}</p>
    </div>
    <Button data-testid="project-delete" type="button" variant="destructive" :disabled="deletingProject" @click="deleteProject">
      {{ deletingProject ? t('common.loading') : t('projects.settings.delete') }}
    </Button>
  </section>
</template>
