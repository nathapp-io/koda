<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import type { ProjectSkillDto } from '~/composables/useProjectSkills'
import { buildThreadCreateSchema, eligibleAgents, isAgentChoiceKey, threadModeChoices, toCreateThreadBody } from '~/lib/thread-create'
import type { AgentChoiceKey, ThreadCreateFormValues } from '~/lib/thread-create'
import type { ChatThreadKind } from '~/lib/thread-types'
import { repoChoices } from '~/lib/fleet-repo-choices'
import { apiPath } from '~/lib/api-path'
import AgentReadinessNotice from '~/components/fleet/threads/AgentReadinessNotice.vue'
import { useAgentRecheck } from '~/composables/useAgentRecheck'

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
 * US-009: every not-ready agent the form can offer, with the probe detail that explains it. One
 * notice each, shown under the picker whichever agent is chosen — a native-chosen form still tells
 * the person that Codex timed out and can be re-checked.
 */
const readinessNotices = computed(() => agents.value.filter(choice => choice.probe !== undefined))
/** The global Re-check gate: it is the key `POST /fleet/runners/:id/reprobe` requires. */
const { permissions: globalPermissions } = useGlobalPermissions()
const canRecheck = computed(() => globalPermissions.value.has('fleet.runner.update'))
/**
 * US-009: the Re-check reads the form's own agent list back, and `options.load` re-reads both fleet
 * lists in place (it never blanks them, so `watch(agents)` keeps the chosen agent where it is).
 */
const { recheck, rechecking } = useAgentRecheck(
  options.load,
  agent => agents.value.find(choice => choice.agent === agent),
)
/**
 * Create needs a ready agent, not a model: a native backend always has one (readiness means a runner
 * offers a native model), while a ready ACP agent may advertise none and run on its own default.
 */
const canSubmit = computed(() => chosenAgent.value?.available === true)
const showAgentUnavailable = computed(() => options.settled.value && chosenAgent.value?.available === false && !isSubmitting.value)
/** US-011: the REPO mode select offers only the modes the caller's project keys allow. */
const modeOptions = computed(() => threadModeChoices(key => permissions.value.has(key))
  .map(mode => ({ value: mode, label: t(`fleet.threads.new.mode.${mode}`) })))
/** US-005: a repo name two repos share is labelled with its host. */
const repoOptions = computed(() => repoChoices(options.repos.value))
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

/** US-009: re-check the agent whose notice was clicked — never the one the form has chosen. */
function recheckAgent(agent: AgentChoiceKey): void {
  if (!isAgentChoiceKey(agent) || agent === 'native') return
  void recheck(agent)
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
          <FormLabel for="thread-new-scope">{{ t('fleet.threads.new.scope') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="scopeOptions" id="thread-new-scope" testid="thread-new-scope" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="repoId">
        <FormItem>
          <FormLabel for="thread-new-repo">{{ t('fleet.threads.new.repo') }} <span aria-hidden="true">*</span></FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.threads.new.repoPlaceholder')" id="thread-new-repo" testid="thread-new-repo" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="baseRef">
        <FormItem>
          <FormLabel for="thread-new-baseRef">{{ t('fleet.threads.new.baseRef') }}</FormLabel>
          <FormControl><Input v-bind="componentField" id="thread-new-baseRef" :placeholder="selectedRepo?.defaultBranch ?? ''" data-testid="thread-new-baseRef" /></FormControl>
          <p v-if="selectedRepo" class="text-sm text-muted-foreground">{{ t('fleet.threads.new.baseRefHint', { branch: selectedRepo.defaultBranch }) }}</p>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-if="!isProject" v-slot="{ componentField }" name="feature">
        <FormItem>
          <FormLabel for="thread-new-feature">{{ t('fleet.threads.new.feature') }} <span aria-hidden="true">*</span></FormLabel>
          <FormControl><Input v-bind="componentField" id="thread-new-feature" aria-required="true" data-testid="thread-new-feature" /></FormControl>
          <p class="text-sm text-muted-foreground">{{ t('fleet.threads.new.featureHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="title">
        <FormItem>
          <FormLabel for="thread-new-title">{{ t('fleet.threads.new.threadTitle') }}</FormLabel>
          <FormControl><Input v-bind="componentField" id="thread-new-title" data-testid="thread-new-title" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="maxCostUsd">
        <FormItem>
          <FormLabel for="thread-new-cap">{{ t('fleet.threads.new.maxCost') }}</FormLabel>
          <FormControl><Input v-bind="componentField" id="thread-new-cap" type="number" min="0.0001" max="10000" step="0.0001" data-testid="thread-new-cap" /></FormControl>
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
      <!-- US-009: one readiness notice per not-ready agent under the picker, whichever agent is chosen. -->
      <AgentReadinessNotice
        v-for="notice in readinessNotices"
        :key="notice.agent"
        :choice="notice"
        :can-recheck="canRecheck"
        :rechecking="rechecking === notice.agent"
        :disabled="rechecking !== null"
        @recheck="recheckAgent(notice.agent)"
      />
      <FormField v-if="!isProject" v-slot="{ componentField }" name="mode">
        <FormItem>
          <FormLabel for="thread-new-mode">{{ t('fleet.threads.new.mode.label') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="modeOptions" id="thread-new-mode" testid="thread-new-mode" /></FormControl>
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
      <p v-if="showAgentUnavailable" class="text-sm text-muted-foreground" data-testid="thread-new-unavailable">{{ t('fleet.threads.new.agentUnavailable') }}</p>
      <Button type="submit" :disabled="isSubmitting || !canSubmit">{{ t('fleet.threads.new.create') }}</Button>
    </form>
  </div>
</template>
