<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { extractApiError } from '~/composables/useApi'
import type { ProjectSkillDto } from '~/composables/useProjectSkills'
import { buildThreadCreateSchema, eligibleModels, toCreateThreadBody } from '~/lib/thread-create'
import type { ThreadCreateFormValues } from '~/lib/thread-create'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import { apiPath } from '~/lib/api-path'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const options = useFleetDispatchOptions(slug)
const skillsApi = useProjectSkills()
const { data: viewer } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewer.value))
const skills = ref<ProjectSkillDto[]>([])
const loadFailed = ref(false)
const submitError = ref('')
const skillsError = ref('')
const models = computed(() => eligibleModels(options.runners.value))
const repoOptions = computed(() => options.repos.value.map(repo => ({ value: repo.id, label: `${repo.owner}/${repo.name}` })))
const selectedRepo = computed(() => options.repos.value.find(repo => repo.id === values.repoId) ?? null)
const { handleSubmit, isSubmitting, values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildThreadCreateSchema(t)),
  initialValues: { repoId: '', baseRef: '', feature: '', title: '', maxCostUsd: 5, model: '', effort: '' },
  keepValuesOnUnmount: true,
})

watch(models, (available) => {
  if (!values.model || !available.includes(values.model)) {
    setFieldValue('model', available[0] ?? '')
  }
}, { immediate: true })

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
    const { $api } = useApi()
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
    <p v-if="!canWork" class="text-sm text-muted-foreground">{{ t('fleet.threads.new.noPermission') }}</p>
    <div v-else-if="loadFailed" class="space-y-3">
      <ErrorState />
      <p v-if="submitError" class="text-sm" role="alert">{{ submitError }}</p>
    </div>
    <form v-else class="space-y-5" data-testid="thread-create-form" @submit="submit">
      <FormField v-slot="{ componentField }" name="repoId">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.repo') }}</FormLabel>
          <FormControl><FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.threads.new.repoPlaceholder')" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="baseRef">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.baseRef') }}</FormLabel>
          <FormControl><Input v-bind="componentField" :placeholder="selectedRepo?.defaultBranch ?? ''" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="feature">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.feature') }}</FormLabel>
          <FormControl><Input v-bind="componentField" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="title">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.threadTitle') }}</FormLabel>
          <FormControl><Input v-bind="componentField" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField v-slot="{ componentField }" name="maxCostUsd">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.maxCost') }}</FormLabel>
          <FormControl><Input v-bind="componentField" type="number" min="0.0001" max="10000" step="0.0001" /></FormControl>
          <FormMessage />
        </FormItem>
      </FormField>
      <FormField name="model">
        <FormItem>
          <FormLabel>{{ t('fleet.threads.new.backend') }}</FormLabel>
          <BackendPicker :models="models" :model="values.model" :effort="values.effort" @update:model="setFieldValue('model', $event)" @update:effort="setFieldValue('effort', $event)" />
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
      <Button type="submit" :disabled="isSubmitting || models.length === 0">{{ t('fleet.threads.new.create') }}</Button>
    </form>
  </div>
</template>
