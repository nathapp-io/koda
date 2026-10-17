<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { eligibleModels } from '~/lib/thread-create'
import { buildWorkspaceThreadCreateSchema, toCreateWorkspaceThreadBody } from '~/lib/workspace-thread-create'
import type { WorkspaceThreadCreateFormValues } from '~/lib/workspace-thread-create'

definePageMeta({ layout: 'default' })

/**
 * The personal (workspace) thread create form (fleet S5b 1d, 1d2-D11). It is not project-scoped: a
 * WORKSPACE thread runs with no checkout, and its home project is bookkeeping the API resolves when
 * none is picked (`Automatic`). Models come from the runner summaries of the picked home project —
 * or of the first listed project while Automatic is selected, since the summaries are the same for
 * every project — and only from online, enabled runners advertising `workspaceThreads`.
 */
interface HomeProjectOption { slug: string; name: string }

const { t } = useI18n()
const { $api } = useApi()
/**
 * Created during setup, not inside `loadRunners`: the runner read runs after `GET /projects` has
 * settled, and a composable built there would call `useApi()` — and through it `useI18n()` — with no
 * component instance left, which throws and leaves the form with no model to pick. `load(slug)` is
 * the per-project part and takes the slug the selection resolves to (1d2-D11, 1d2-D12).
 */
const runnerSummaries = useProjectRunnerSummaries()

const projects = ref<HomeProjectOption[]>([])
const loadFailed = ref(false)
const submitError = ref('')

const { handleSubmit, isSubmitting, values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildWorkspaceThreadCreateSchema(t)),
  initialValues: { homeProject: '', title: '', maxCostUsd: 5, model: '', effort: '' },
  keepValuesOnUnmount: true,
})

/** Automatic first (it sends no `homeProject`), then the caller's projects. */
const homeProjectOptions = computed(() => [
  { value: '', label: t('fleet.threads.workspace.homeAutomatic') },
  ...projects.value.map(project => ({ value: project.slug, label: project.name })),
])

const models = computed(() => eligibleModels(runnerSummaries.runners.value, 'WORKSPACE'))

/** The project whose runners offer the models: the picked home project, else the first listed one. */
const runnerSlug = computed(() => values.homeProject || projects.value[0]?.slug || '')

async function loadRunners(): Promise<void> {
  const slug = runnerSlug.value
  runnerSummaries.runners.value = []
  if (!slug) return
  try {
    // The runner summaries are the same for every project (1d2-D11), so this only follows the
    // selection; with no project listed there is nothing to read them from.
    await runnerSummaries.load(slug)
  } catch (error: unknown) {
    submitError.value = extractApiError(error)
  }
}

watch(models, (available) => {
  if (!values.model || !available.includes(values.model)) {
    setFieldValue('model', available[0] ?? '')
  }
}, { immediate: true })

watch(() => values.homeProject, () => { void loadRunners() })

onMounted(async () => {
  try {
    projects.value = await $api.get<HomeProjectOption[]>('/projects')
  } catch (error: unknown) {
    loadFailed.value = true
    submitError.value = extractApiError(error)
    return
  }
  await loadRunners()
})

const submit = handleSubmit(async (formValues: WorkspaceThreadCreateFormValues) => {
  submitError.value = ''
  try {
    const thread = await $api.post<{ id: string }>('/threads', { ...toCreateWorkspaceThreadBody(formValues) })
    await navigateTo(`/threads/${thread.id}`)
  } catch (error: unknown) {
    submitError.value = extractApiError(error)
  }
})
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <PageHeader :title="t('fleet.threads.new.title')" />
    <div v-if="loadFailed" class="space-y-3">
      <ErrorState />
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
    </div>
    <form v-else class="space-y-5" data-testid="workspace-thread-create-form" @submit="submit">
      <FormField v-slot="{ componentField }" name="homeProject">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.workspace.homeProject') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="homeProjectOptions" testid="thread-new-home-project" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="title">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.threadTitle') }}</FormLabel>
          <FormControl><Input v-bind="componentField" data-testid="thread-new-title" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="maxCostUsd">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.maxCost') }}</FormLabel>
          <FormControl><Input v-bind="componentField" type="number" min="0.0001" max="10000" step="0.0001" data-testid="thread-new-cap" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField name="model">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.backend') }}</FormLabel>
          <FleetThreadsBackendPicker
            :models="models"
            :model="values.model ?? ''"
            :effort="values.effort ?? ''"
            @update:model="setFieldValue('model', $event)"
            @update:effort="setFieldValue('effort', $event as '' | 'low' | 'medium' | 'high' | 'xhigh')"
          />
          <FormMessage />
        </FormItem>
      </FormField>
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
      <Button type="submit" :disabled="isSubmitting || models.length === 0">{{ t('fleet.threads.new.create') }}</Button>
    </form>
  </div>
</template>
