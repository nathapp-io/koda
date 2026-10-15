<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

interface ProjectDetails {
  id: string
  name: string
  slug: string
  key: string
  description?: string | null
  /** The project brief (fleet S5b US-001); the API enforces the limit below. */
  brief?: string | null
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

/** The API's limit on `brief` (UpdateProjectDto); the textarea and its counter mirror it. */
const BRIEF_MAX_LENGTH = 3000

const projectForm = reactive({
  name: props.project.name,
  key: props.project.key,
  description: props.project.description ?? '',
  brief: props.project.brief ?? '',
})
const savingProject = ref(false)

watch(() => props.project, (project) => {
  if (!project) return
  projectForm.name = project.name
  projectForm.key = project.key
  projectForm.description = project.description ?? ''
  projectForm.brief = project.brief ?? ''
})

async function saveProject() {
  const payload: Record<string, unknown> = {}
  if (projectForm.name !== props.project.name) payload.name = projectForm.name
  if (projectForm.key !== props.project.key) payload.key = projectForm.key
  if ((projectForm.description || '') !== (props.project.description ?? '')) payload.description = projectForm.description
  // An emptied brief clears the column; `brief` is only sent when the admin changed it.
  if (projectForm.brief !== (props.project.brief ?? '')) payload.brief = projectForm.brief === '' ? null : projectForm.brief

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
      <Textarea
        v-model="projectForm.description"
        data-testid="project-description"
        :placeholder="t('projects.settings.projectDescriptionPlaceholder')"
      />
    </div>
    <div class="space-y-2">
      <FormLabel>{{ t('projects.settings.brief') }}</FormLabel>
      <Textarea
        v-model="projectForm.brief"
        data-testid="project-brief"
        :maxlength="BRIEF_MAX_LENGTH"
        :placeholder="t('projects.settings.briefHint')"
      />
      <p class="text-xs text-muted-foreground" data-testid="project-brief-count">
        {{ projectForm.brief.length }}/{{ BRIEF_MAX_LENGTH }}
      </p>
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
