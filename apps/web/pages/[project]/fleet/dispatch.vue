<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { ApiError, extractApiError } from '~/composables/useApi'
import { buildDispatchSchema, DISPATCH_DEFAULTS, toDispatchBody } from '~/lib/fleet-dispatch'
import { canWorkOnFleet } from '~/lib/fleet-jobs'
import type { DispatchResultDto, FleetJobDto, FleetRunnerSummary } from '~/lib/fleet-types'
import FleetPlacementResult from '~/components/fleet/FleetPlacementResult.vue'
import FleetTokenListInput from '~/components/fleet/FleetTokenListInput.vue'

definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const { t } = useI18n()
const toast = useAppToast()
const jobsApi = useFleetJobs(slug)
const options = useFleetDispatchOptions(slug)
const { data: viewer } = useProjectViewerRole(slug)
const canWork = computed(() => canWorkOnFleet(viewer.value))

const loadFailed = ref(false)
onMounted(async () => {
  try {
    await options.load()
  }
  catch (err: unknown) {
    loadFailed.value = true
    toast.error(extractApiError(err))
  }
})

async function retry(): Promise<void> {
  try {
    await options.load()
    loadFailed.value = false
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
  }
}

const { handleSubmit, isSubmitting, values, setFieldValue } = useForm({
  validationSchema: toTypedSchema(buildDispatchSchema(t)),
  initialValues: { ...DISPATCH_DEFAULTS },
  keepValuesOnUnmount: true,
})

/** Placement is one of: any fitting runner, runners with all of some labels, or one pinned runner (S1 spec §4). */
type PlacementMode = 'auto' | 'labels' | 'pin'
const placementMode = ref<PlacementMode>('auto')
function setPlacementMode(mode: string): void {
  placementMode.value = mode as PlacementMode
  if (mode !== 'labels') setFieldValue('selectorLabels', [])
  if (mode !== 'pin') setFieldValue('pinnedRunnerId', '')
}

const selectedRepo = computed(() => options.repos.value.find(r => r.id === values.repoId) ?? null)

// Native select options (4b D137).
const repoOptions = computed(() => options.repos.value.map(r => ({ value: r.id, label: `${r.owner}/${r.name}` })))
const commandOptions = computed(() => [
  { value: 'RUN', label: t('fleet.dispatch.commandRun') },
  { value: 'PLAN', label: t('fleet.dispatch.commandPlan') },
])
function runnerOptionLabel(runner: FleetRunnerSummary): string {
  if (!runner.enabled) return `${runner.name} (${t('fleet.dispatch.runnerDisabled')})`
  return runner.online ? runner.name : `${runner.name} (${t('fleet.dispatch.runnerOffline')})`
}
const pinOptions = computed(() => options.runners.value.map(r => ({ value: r.id, label: runnerOptionLabel(r) })))
const result = ref<DispatchResultDto | null>(null)
const activeJob = ref<FleetJobDto | null>(null)

const onSubmit = handleSubmit(async (formValues) => {
  result.value = null
  activeJob.value = null
  try {
    result.value = await jobsApi.dispatch(toDispatchBody(formValues))
  }
  catch (err: unknown) {
    // D121: a 409 means an active job already runs this (repo, feature); link to it.
    if (err instanceof ApiError && err.code === 409) {
      activeJob.value = await jobsApi.findActiveJob(formValues.repoId, formValues.feature.trim()).catch(() => null)
    }
    toast.error(extractApiError(err))
  }
})
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <PageHeader :title="t('fleet.dispatch.title')" :subtitle="t('fleet.dispatch.subtitle')" />

    <p v-if="!canWork" class="text-sm text-muted-foreground" data-testid="dispatch-no-permission">{{ t('fleet.dispatch.noPermission') }}</p>
    <ErrorState v-else-if="loadFailed" @retry="retry()" />
    <p v-else-if="options.repos.value.length === 0" class="text-sm text-muted-foreground" data-testid="dispatch-no-repos">{{ t('fleet.dispatch.noRepos') }}</p>

    <form v-else class="space-y-5" data-testid="dispatch-form" @submit="onSubmit">
      <FormField v-slot="{ componentField }" name="repoId">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.repo') }}</FormLabel>
          <FormControl>
            <FleetNativeSelect v-bind="componentField" :options="repoOptions" :placeholder="t('fleet.dispatch.repoPlaceholder')" testid="dispatch-repo" />
          </FormControl>
          <p v-if="options.moreRepos.value" class="text-xs text-muted-foreground">{{ t('fleet.dispatch.moreRepos') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <div class="grid gap-4 sm:grid-cols-2">
        <FormField v-slot="{ componentField }" name="command">
          <FormItem>
            <FormLabel>{{ t('fleet.dispatch.command') }}</FormLabel>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="commandOptions" testid="dispatch-command" />
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>
        <FormField v-slot="{ componentField }" name="ref">
          <FormItem>
            <FormLabel>{{ t('fleet.dispatch.ref') }}</FormLabel>
            <FormControl>
              <Input v-bind="componentField" :placeholder="selectedRepo?.defaultBranch ?? ''" data-testid="dispatch-ref" />
            </FormControl>
            <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.refHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
      </div>

      <FormField v-slot="{ componentField }" name="feature">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.feature') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" data-testid="dispatch-feature" />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-if="values.command === 'PLAN'" v-slot="{ componentField }" name="planFrom">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.planFrom') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" data-testid="dispatch-plan-from" />
          </FormControl>
          <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.planFromHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField name="profiles">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.profiles') }}</FormLabel>
          <FleetTokenListInput
            :model-value="values.profiles ?? []"
            :suggestions="options.profileOptions.value"
            :placeholder="t('fleet.dispatch.profilePlaceholder')"
            test-id="dispatch-profiles"
            @update:model-value="setFieldValue('profiles', $event)"
          />
          <p class="text-xs text-muted-foreground">{{ t('fleet.dispatch.profilesHint') }}</p>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-slot="{ componentField }" name="maxCostUsd">
        <FormItem>
          <FormLabel>{{ t('fleet.dispatch.maxCost') }}</FormLabel>
          <FormControl>
            <Input v-bind="componentField" type="number" min="0.0001" step="0.0001" data-testid="dispatch-max-cost" />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <div class="space-y-3">
        <Label>{{ t('fleet.dispatch.placement') }}</Label>
        <RadioGroup :model-value="placementMode" class="flex flex-wrap gap-4" @update:model-value="setPlacementMode">
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="auto" data-testid="placement-auto" />{{ t('fleet.dispatch.placementAuto') }}</label>
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="labels" data-testid="placement-labels" />{{ t('fleet.dispatch.placementLabels') }}</label>
          <label class="flex items-center gap-2 text-sm"><RadioGroupItem value="pin" data-testid="placement-pin" />{{ t('fleet.dispatch.placementPin') }}</label>
        </RadioGroup>

        <FormField v-if="placementMode === 'labels'" name="selectorLabels">
          <FormItem>
            <FleetTokenListInput
              :model-value="values.selectorLabels ?? []"
              :suggestions="options.labelOptions.value"
              :placeholder="t('fleet.dispatch.labelPlaceholder')"
              test-id="dispatch-labels"
              @update:model-value="setFieldValue('selectorLabels', $event)"
            />
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-if="placementMode === 'pin'" v-slot="{ componentField }" name="pinnedRunnerId">
          <FormItem>
            <FormControl>
              <FleetNativeSelect v-bind="componentField" :options="pinOptions" :placeholder="t('fleet.dispatch.pinPlaceholder')" testid="dispatch-pin" />
            </FormControl>
            <p v-if="options.moreRunners.value" class="text-xs text-muted-foreground">{{ t('fleet.dispatch.moreRunners') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>
      </div>

      <Button type="submit" :disabled="isSubmitting" data-testid="dispatch-submit">
        {{ isSubmitting ? t('fleet.dispatch.submitting') : t('fleet.dispatch.submit') }}
      </Button>
    </form>

    <div v-if="activeJob" class="rounded-md border border-border p-4 text-sm" data-testid="dispatch-conflict">
      {{ t('fleet.dispatch.conflict') }}
      <NuxtLink :to="`/${slug}/fleet/jobs/${activeJob.id}`" class="font-medium text-primary underline-offset-4 hover:underline" data-testid="dispatch-conflict-link">
        {{ t('fleet.dispatch.conflictLink') }}
      </NuxtLink>
    </div>

    <FleetPlacementResult v-if="result" :slug="slug" :result="result" :runner-name="options.runnerName" />
  </div>
</template>
