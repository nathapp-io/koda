<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import type { ProjectSkillDto } from '~/composables/useProjectSkills'
import { buildThreadCreateSchema, eligibleAgents, isAgentChoiceKey, threadModeChoices, toCreateThreadBody } from '~/lib/thread-create'
import type { ThreadCreateFormValues } from '~/lib/thread-create'
import type { ChatThreadKind } from '~/lib/thread-types'
import { apiPath } from '~/lib/api-path'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const { $api } = useApi()
const options = useFleetDispatchOptions(slug)
const skillsApi = useProjectSkills()
// Permissions P1 US-007: the create form needs `thread.create` in this project. A pending or failed
// permissions fetch leaves the key absent, so the form stays closed.
const { permissions } = useProjectPermissions(slug)
const canCreate = computed(() => permissions.value.has('thread.create'))
const skills = ref<ProjectSkillDto[]>([])
const loadFailed = ref(false)
const submitError = ref('')
const skillsError = ref('')
/** A PROJECT thread offers PROJECT-capable runners only; a REPO thread any of them (S5b). */
const scopeKind = computed<ChatThreadKind>(() => (values.kind === 'PROJECT' ? 'PROJECT' : 'REPO'))
/**
 * US-011: the agent select's options, each with the models and efforts it offers. An agent no
 * eligible runner can start stays in the list but is disabled with its reason.
 */
const agents = computed(() => eligibleAgents(options.runners.value, scopeKind.value))
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
/** US-011: the REPO mode select offers only the modes the caller's project keys allow. */
const modeOptions = computed(() => threadModeChoices(key => permissions.value.has(key))
  .map(mode => ({ value: mode, label: t(`fleet.threads.new.mode.${mode}`) })))
const repoOptions = computed(() => options.repos.value.map(repo => ({ value: repo.id, label: `${repo.owner}/${repo.name}` })))
const selectedRepo = computed(() => options.repos.value.find(repo => repo.id === values.repoId) ?? null)
/** The scope picker (S5b 1a-R5): Repo is the default, so today's behaviour survives. */
const scopeOptions = computed(() => [
  { value: 'REPO', label: t('fleet.threads.new.scopeRepo') },
  { value: 'PROJECT', label: t('fleet.threads.new.scopeProject') },
])
/** A PROJECT thread has no repository, base ref or feature; the form hides those fields. */
const isProject = computed(() => values.kind === 'PROJECT')
const { handleSubmit, isSubmitting, values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildThreadCreateSchema(t)),
  initialValues: {
    kind: 'REPO', repoId: '', baseRef: '', feature: '', title: '', maxCostUsd: 5,
    agent: 'native', mode: 'read', model: '', effort: '',
  },
  keepValuesOnUnmount: true,
})

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

/** A key the caller lost (a role change) must not stay selected in a select that no longer offers it. */
watch(modeOptions, (available) => {
  if (available.some(option => option.value === values.mode)) return
  setFieldValue('mode', 'read')
}, { immediate: true })

/** Switching agent switches the model and effort lists with it. */
function chooseAgent(agent: string): void {
  // The select's value is a plain string; anything the form cannot submit is ignored.
  if (!isAgentChoiceKey(agent)) return
  setFieldValue('agent', agent)
  const choice = agents.value.find(option => option.agent === agent)
  setFieldValue('model', choice?.models[0] ?? '')
  setFieldValue('effort', '')
}

onMounted(async () => {
  void skillsApi.list(slug).then((result) => {
    skills.value = result.filter(skill => skill.enabled)
  }).catch((error: unknown) => {
    skillsError.value = extractApiError(error)
  })
  try {
    await options.load()
  }
  catch (error: unknown) {
    loadFailed.value = true
    submitError.value = extractApiError(error)
  }
})

const submit = handleSubmit(async (formValues: ThreadCreateFormValues) => {
  submitError.value = ''
  try {
    const thread = await $api.post<{ id: string }>(apiPath`/projects/${slug}/threads`, { ...toCreateThreadBody(formValues) })
    await navigateTo(`/${slug}/threads/${thread.id}`)
  }
  catch (error: unknown) {
    submitError.value = extractApiError(error)
  }
})
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <PageHeader :title="t('fleet.threads.new.title')" />
    <p v-if="!canCreate" class="text-sm text-muted-foreground">{{ t('fleet.threads.new.noPermission') }}</p>
    <div v-else-if="loadFailed" class="space-y-3">
      <ErrorState />
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
    </div>
    <form v-else class="space-y-5" data-testid="thread-create-form" @submit="submit">
      <FormField v-slot="{ componentField }" name="kind">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.scope') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="scopeOptions" testid="thread-new-scope" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="repoId">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.repo') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.threads.new.repoPlaceholder')" testid="thread-new-repo" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="baseRef">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.baseRef') }}</FormLabel>
          <FormControl><Input v-bind="componentField" :placeholder="selectedRepo?.defaultBranch ?? ''" data-testid="thread-new-baseRef" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="feature">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.feature') }}</FormLabel>
          <FormControl><Input v-bind="componentField" data-testid="thread-new-feature" /></FormControl>
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
      <FormField v-if="!isProject" v-slot="{ componentField }" name="mode">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.mode.label') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="modeOptions" testid="thread-new-mode" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <section class="space-y-2" :aria-label="t('fleet.threads.new.skills')">
        <h2 class="text-sm font-medium">{{ t('fleet.threads.new.skills') }}</h2>
        <ul class="space-y-1 text-sm text-muted-foreground">
          <li v-for="skill in skills" :key="skill.id">{{ skill.name }}<span v-if="skill.source.resolvedSha"> · {{ skill.source.resolvedSha.slice(0, 7) }}</span></li>
        </ul>
        <p v-if="skillsError" class="text-sm" role="alert">{{ skillsError }}</p>
      </section>
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
      <Button type="submit" :disabled="isSubmitting || !canSubmit">{{ t('fleet.threads.new.create') }}</Button>
    </form>
  </div>
</template>
