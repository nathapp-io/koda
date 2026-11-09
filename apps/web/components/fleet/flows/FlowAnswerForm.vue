<script setup lang="ts">
import { computed, ref } from 'vue'
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import { z } from 'zod'
import { extractApiError } from '~/composables/useApi'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { openQuestions } from '~/lib/fleet-flows'
import type { FleetFlowFeatureDto } from '~/lib/fleet-flows'

const props = defineProps<{ slug: string; flowId: string; feature: FleetFlowFeatureDto }>()
const emit = defineEmits<{ answered: [] }>()
const { t } = useI18n()
const toast = useAppToast()
const flows = useFleetFlows(props.slug)
const questions = computed(() => openQuestions(props.feature))
const values = ref<Record<string, string>>(Object.fromEntries(questions.value.map(q => [q.id, ''])))
const schema = toTypedSchema(z.object(Object.fromEntries(questions.value.map(q => [q.id, z.string().trim().min(1, t('fleet.flows.answer.required'))]))))
const { handleSubmit, errors, defineField, isSubmitting } = useForm({ validationSchema: schema, initialValues: values.value })
const fields = questions.value.map(q => ({ question: q, field: defineField(q.id) }))
const showApprovalLink = ref(false)

const submit = handleSubmit(async (answers) => {
  showApprovalLink.value = false
  const jobId = props.feature.questionsJobId
  if (!jobId) return
  try {
    const result = await flows.answer(props.flowId, jobId, questions.value.map(q => ({ id: q.id, answer: answers[q.id] ?? '' })))
    if (result.kind === 'pending') {
      showApprovalLink.value = true
      toast.success(t('fleet.flows.toast.approvalRequested'))
    }
    else toast.success(t('fleet.flows.answer.success'))
    emit('answered')
  }
  catch (err: unknown) {
    toast.error(extractApiError(err))
    emit('answered')
  }
})
</script>

<template>
  <form class="space-y-3 border-t border-border pt-3" @submit.prevent="submit">
    <div v-for="item in fields" :key="item.question.id" class="space-y-1">
      <label class="text-sm font-medium">{{ item.question.question }}
        <input :value="item.field[0].value" type="text" required class="w-full rounded-md border border-input bg-background px-3 py-2" @input="item.field[0].value = ($event.target as HTMLInputElement).value" />
      </label>
      <p v-if="errors[item.question.id]" role="alert" class="text-sm text-destructive">{{ errors[item.question.id] }}</p>
    </div>
    <button type="submit" class="rounded-md border border-border px-3 py-1 text-sm" :disabled="isSubmitting">{{ t('fleet.flows.answer.submit') }}</button>
    <p v-if="showApprovalLink" role="status" class="text-sm">{{ t('fleet.flows.toast.approvalRequested') }} <NuxtLink class="underline" :to="`/${slug}/approvals`">{{ t('fleet.flows.answer.openApprovals') }}</NuxtLink></p>
  </form>
</template>
