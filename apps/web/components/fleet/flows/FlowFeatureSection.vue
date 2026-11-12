<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import FlowAnswerForm from '~/components/fleet/flows/FlowAnswerForm.vue'
import { featureBranch, featureStateKey, flowStepKey, openQuestions, prUrl } from '~/lib/fleet-flows'
import type { FleetFlowDto, FleetFlowFeatureDto, FleetFlowJobDto, FlowRepo } from '~/lib/fleet-flows'
import { formatUsd } from '~/lib/fleet-jobs'

const props = defineProps<{
  slug: string
  flow: FleetFlowDto
  feature: FleetFlowFeatureDto
  repo: FlowRepo | null
  jobs: FleetFlowJobDto[]
  canAnswer: boolean
}>()
const emit = defineEmits<{ answered: [pending?: boolean] }>()
const { t, te } = useI18n()
const stateLabel = computed(() => {
  const key = featureStateKey(props.feature.state)
  return key ? t(key) : props.feature.state
})
const stepLabel = computed(() => {
  const step = props.feature.currentStep
  if (step === null) return '—'
  const key = flowStepKey(step)
  return key ? t(key) : step
})
const pullRequestUrl = computed(() => prUrl(props.repo, props.feature.prNumber))
const questions = computed(() => openQuestions(props.feature))
/**
 * The answer form belongs to one question round (the asking job and its question ids). A later
 * round gets a fresh form, so answers typed for the round on screen are never sent to it.
 */
const answerRoundKey = computed(() => `${props.feature.questionsJobId ?? ''}|${questions.value.map(q => q.id).join(',')}`)
function onAnswered(pending?: boolean): void { emit('answered', pending) }
</script>

<template>
  <section class="space-y-3 rounded-md border border-border p-4" :data-feature="feature.feature">
    <div class="space-y-1">
      <h2 class="font-medium">{{ feature.feature }}</h2>
      <p class="text-sm">{{ stateLabel }} · {{ stepLabel }}</p>
      <p class="text-sm"><span class="text-muted-foreground">{{ t('fleet.flows.feature.branch') }}</span> {{ featureBranch(flow, feature) }}</p>
      <p v-if="feature.dependsOn.length" class="text-sm"><span class="text-muted-foreground">{{ t('fleet.flows.feature.dependsOn') }}</span> {{ feature.dependsOn.join(', ') }}</p>
      <p v-if="feature.prNumber" class="text-sm">
        <span class="text-muted-foreground">{{ t('fleet.flows.feature.pullRequest') }} </span>
        <a v-if="pullRequestUrl" :href="pullRequestUrl" target="_blank" rel="noopener noreferrer" class="underline">#{{ feature.prNumber }}</a>
        <span v-else>#{{ feature.prNumber }}</span>
      </p>
    </div>
    <ul v-if="jobs.length" class="space-y-2 border-t border-border pt-3">
      <li v-for="job in jobs" :key="job.id" class="text-sm">
        <NuxtLink class="underline" :to="`/${slug}/fleet/jobs/${job.id}`">
          {{ job.step ? (flowStepKey(job.step) ? t(flowStepKey(job.step)!) : job.step) : '—' }} · {{ codeLabel(t, te, 'fleet.command', job.command) }} · {{ codeLabel(t, te, 'fleet.state', job.state) }} · {{ formatUsd(job.costUsd) }}
        </NuxtLink>
      </li>
    </ul>
    <FlowAnswerForm
      v-if="flow.state === 'WAITING_ANSWER' && canAnswer && questions.length && feature.questionsJobId"
      :key="answerRoundKey"
      :slug="slug"
      :flow-id="flow.id"
      :feature="feature"
      @answered="onAnswered"
    />
  </section>
</template>
