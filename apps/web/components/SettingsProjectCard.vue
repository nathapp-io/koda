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

const props = defineProps<{
  project: ProjectDetails
}>()

const emit = defineEmits<{
  (e: 'saved'): void
}>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const projectForm = reactive({
  name: props.project.name,
  key: props.project.key,
  description: props.project.description ?? '',
})
const savingProject = ref(false)

watch(() => props.project, (project) => {
  if (!project) return
  projectForm.name = project.name
  projectForm.key = project.key
  projectForm.description = project.description ?? ''
})

async function saveProject() {
  const payload: Record<string, unknown> = {}
  if (projectForm.name !== props.project.name) payload.name = projectForm.name
  if (projectForm.key !== props.project.key) payload.key = projectForm.key
  if ((projectForm.description || '') !== (props.project.description ?? '')) payload.description = projectForm.description

  if (Object.keys(payload).length === 0) {
    toast.success(t('projects.settings.noChanges'))
    return
  }

  savingProject.value = true
  try {
    await $api.patch(apiPath`/projects/${props.project.slug}`, payload)
    toast.success(t('projects.settings.updated'))
    emit('saved')
  } catch (err) {
    toast.error(extractApiError(err))
  } finally {
    savingProject.value = false
  }
}

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
  <form class="space-y-4" @submit.prevent="saveProject">
    <div class="space-y-2">
      <FormLabel>{{ t('projects.form.name') }}</FormLabel>
      <Input v-model="projectForm.name" :placeholder="t('projects.form.namePlaceholder')" />
    </div>
    <div class="space-y-2">
      <FormLabel>{{ t('projects.form.key') }}</FormLabel>
      <Input v-model="projectForm.key" :placeholder="t('projects.form.keyPlaceholder')" />
    </div>
    <div class="space-y-2">
      <FormLabel>{{ t('projects.settings.projectDescription') }}</FormLabel>
      <Textarea v-model="projectForm.description" :placeholder="t('projects.settings.projectDescriptionPlaceholder')" />
    </div>

    <div class="flex flex-wrap gap-3">
      <Button type="submit" :disabled="savingProject">
        {{ savingProject ? t('common.loading') : t('projects.settings.save') }}
      </Button>
      <Button type="button" variant="destructive" :disabled="deletingProject" @click="deleteProject">
        {{ deletingProject ? t('common.loading') : t('projects.settings.delete') }}
      </Button>
    </div>
  </form>
</template>
