<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import { eligibleAgents, isAgentChoiceKey } from '~/lib/thread-create'
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
  initialValues: { homeProject: '', title: '', maxCostUsd: 5, agent: 'native', model: '', effort: '' },
  keepValuesOnUnmount: true,
})

/** Automatic first (it sends no `homeProject`), then the caller's projects. */
const homeProjectOptions = computed(() => [
  { value: '', label: t('fleet.threads.workspace.homeAutomatic') },
  ...projects.value.map(project => ({ value: project.slug, label: project.name })),
])

/** US-011: the agent select's options for a no-checkout thread (WORKSPACE-capable runners only). */
const agents = computed(() => eligibleAgents(runnerSummaries.runners.value, 'WORKSPACE'))
/** The chosen agent's entry; the first available one stands in until the form has picked. */
const chosenAgent = computed(() => agents.value.find(choice => choice.agent === values.agent)
  ?? agents.value.find(choice => choice.available)
  ?? agents.value[0])
const models = computed(() => chosenAgent.value?.models ?? [])
const efforts = computed(() => chosenAgent.value?.efforts ?? [])
/**
 * Create needs a ready agent, not a model: a native backend always has one (readiness means a runner
 * offers a native model), while a ready ACP agent may advertise none and run on its own default.
 */
const canSubmit = computed(() => chosenAgent.value?.available === true)

/** The project whose runners offer the models: the picked home project, else the first listed one. */
const runnerSlug = computed(() => values.homeProject || projects.value[0]?.slug || '')

/** Keeps the form on a usable agent when the eligible runners change (one goes offline, say). */
watch(agents, (choices) => {
  if (choices.some(choice => choice.agent === values.agent && choice.available)) return
  setFieldValue('agent', choices.find(choice => choice.available)?.agent ?? 'native')
}, { immediate: true })

/** A model or effort the chosen agent does not offer would fail at the API, so follow the agent. */
watch([models, efforts], () => {
  if (!values.model || !models.value.includes(values.model)) setFieldValue('model', models.value[0] ?? '')
  if (values.effort && !efforts.value.includes(values.effort)) setFieldValue('effort', '')
}, { immediate: true })

/** Switching agent switches the model and effort lists with it (thread-agents-modes US-011). */
function chooseAgent(agent: string): void {
  // The select's value is a plain string; anything the form cannot submit is ignored.
  if (!isAgentChoiceKey(agent)) return
  setFieldValue('agent', agent)
  const choice = agents.value.find(option => option.agent === agent)
  setFieldValue('model', choice?.models[0] ?? '')
  setFieldValue('effort', '')
}

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
            :agents="agents"
            :agent="values.agent ?? 'native'"
            :model="values.model ?? ''"
            :effort="values.effort ?? ''"
            @update:agent="chooseAgent"
            @update:model="setFieldValue('model', $event)"
            @update:effort="setFieldValue('effort', $event)"
          />
          <FormMessage />
        </FormItem>
      </FormField>
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
      <Button type="submit" :disabled="isSubmitting || !canSubmit">{{ t('fleet.threads.new.create') }}</Button>
    </form>
  </div>
</template>
