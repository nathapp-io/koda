<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { z } from 'zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { openQuestions } from '~/lib/fleet-flows'
import type { FleetFlowFeatureDto, FleetFlowQuestionDto } from '~/lib/fleet-flows'

const props = defineProps<{ slug: string; flowId: string; feature: FleetFlowFeatureDto }>()
/** `pending` tells the page that the answer needs an approval, so it keeps its own link to it. */
const emit = defineEmits<{ answered: [pending?: boolean] }>()
const { t } = useI18n()
const toast = useAppToast()
const flows = useFleetFlows(props.slug)

/** One question round: the job that asked the questions and the questions it asked. */
interface AnswerRound {
  jobId: string
  questions: FleetFlowQuestionDto[]
}

const liveQuestions = computed(() => openQuestions(props.feature))
/** A round is a job plus its question ids; a later round may reuse the same ordinal ids. */
const liveRoundKey = computed(() => `${props.feature.questionsJobId ?? ''}|${liveQuestions.value.map(q => q.id).join(',')}`)

/** The round the form shows and submits. A later round replaces it whole. */
const round = ref<AnswerRound>({
  jobId: props.feature.questionsJobId ?? '',
  questions: liveQuestions.value,
})

const schema = computed(() => toTypedSchema(z.object(Object.fromEntries(
  round.value.questions.map(q => [q.id, z.string().trim().min(1, t('fleet.flows.answer.required'))])),
)))

const { handleSubmit, errors, defineField, isSubmitting, resetForm } = useForm({
  validationSchema: schema,
  initialValues: Object.fromEntries(liveQuestions.value.map(q => [q.id, ''])),
})

type AnswerField = { question: FleetFlowQuestionDto; field: ReturnType<typeof defineField> }
const fields = ref<AnswerField[]>([])

function defineFields(questions: FleetFlowQuestionDto[]): void {
  fields.value = questions.map(q => ({ question: q, field: defineField(q.id) }))
}
defineFields(round.value.questions)

/**
 * Polling can hand the page a later question round (a new job, the same ordinal question ids).
 * The form then shows that round's questions and submits against its job, so answers typed for
 * the round that was on screen are never sent to the round that replaced it.
 */
watch(liveRoundKey, () => {
  const next: AnswerRound = { jobId: props.feature.questionsJobId ?? '', questions: liveQuestions.value }
  round.value = next
  defineFields(next.questions)
  resetForm({ values: Object.fromEntries(next.questions.map(q => [q.id, ''])) }, { force: true })
})

const showApprovalLink = ref(false)

const submit = handleSubmit(async (answers) => {
  showApprovalLink.value = false
  const current = round.value
  if (!current.jobId) return
  try {
    const result = await flows.answer(props.flowId, current.jobId, current.questions.map(q => ({ id: q.id, answer: answers[q.id] ?? '' })))
    if (result.kind === 'pending') {
      showApprovalLink.value = true
      toast.success(t('fleet.flows.toast.approvalRequested'))
    }
    else toast.success(t('fleet.flows.answer.success'))
    emit('answered', result.kind === 'pending')
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
    emit('answered', false)
  }
})
</script>

<template>
  <form novalidate class="space-y-3 border-t border-border pt-3" @submit.prevent="submit">
    <div v-for="item in fields" :key="item.question.id" class="space-y-1">
      <label class="text-sm font-medium">{{ item.question.question }}
        <input :value="item.field[0].value" type="text" required class="w-full rounded-md border border-input bg-background px-3 py-2" @input="item.field[0].value = ($event.target as HTMLInputElement).value" />
      </label>
      <p v-if="errors[item.question.id]" role="alert" class="text-sm text-status-rejected">{{ errors[item.question.id] }}</p>
    </div>
    <button type="submit" class="rounded-md border border-border px-3 py-1 text-sm" :disabled="isSubmitting">{{ t('fleet.flows.answer.submit') }}</button>
    <p v-if="showApprovalLink" role="status" class="text-sm">{{ t('fleet.flows.toast.approvalRequested') }} <NuxtLink class="underline" :to="`/${slug}/approvals`">{{ t('fleet.flows.answer.openApprovals') }}</NuxtLink></p>
  </form>
</template>
