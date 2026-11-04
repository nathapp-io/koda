<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'

const props = defineProps<{ itemId: string; submit: (text: string) => Promise<void> }>()
const { t } = useI18n()
const keywords = ['waive', 'confirm', 'override', 'verify', 'fixed'] as const
// Only form usability validation here; the API is the full ruling grammar authority.
const schema = toTypedSchema(z.object({
  keyword: z.enum(keywords),
  reason: z.string().trim(),
}).superRefine((value, ctx) => {
  const prefixLength = value.keyword.length + (value.keyword === 'fixed' ? 1 : value.reason ? 2 : 0)
  if (prefixLength + value.reason.length > 2000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: t('fleet.rulings.validation.tooLong') })
  }
  if (['waive', 'confirm', 'override', 'fixed'].includes(value.keyword) && !value.reason) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: t('fleet.rulings.validation.evidence') })
  }
}))
const { defineField, errors, handleSubmit, isSubmitting } = useForm({
  validationSchema: schema, initialValues: { keyword: 'waive' as typeof keywords[number], reason: '' },
})
const [keyword, keywordAttrs] = defineField('keyword')
const [reason, reasonAttrs] = defineField('reason')
const onSubmit = handleSubmit(async (values) => {
  const text = values.keyword === 'fixed'
    ? `fixed ${values.reason}`
    : `${values.keyword}${values.reason ? `: ${values.reason}` : ''}`
  await props.submit(text)
})
</script>

<template>
  <form class="space-y-2" :data-testid="`ruling-form-${itemId}`" @submit="onSubmit">
    <Label :for="`ruling-keyword-${itemId}`">{{ t('fleet.rulings.keyword') }}</Label>
    <Select v-model="keyword" v-bind="keywordAttrs" :disabled="isSubmitting" :data-testid="`ruling-keyword-${itemId}`">
      <SelectTrigger :id="`ruling-keyword-${itemId}`"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="word in keywords" :key="word" :value="word">{{ word }}</SelectItem>
      </SelectContent>
    </Select>
    <Label :for="`ruling-reason-${itemId}`">{{ t('fleet.rulings.reason') }}</Label>
    <Input :id="`ruling-reason-${itemId}`" v-model="reason" v-bind="reasonAttrs" :disabled="isSubmitting" :aria-invalid="!!errors.reason" :aria-describedby="`ruling-error-${itemId}`" :data-testid="`ruling-reason-${itemId}`" />
    <p class="text-xs text-muted-foreground">{{ t('fleet.rulings.hint') }}</p>
    <p v-if="errors.reason" :id="`ruling-error-${itemId}`" class="text-sm text-destructive" role="alert">{{ errors.reason }}</p>
    <Button type="submit" :disabled="isSubmitting">{{ t('fleet.rulings.submit') }}</Button>
  </form>
</template>
