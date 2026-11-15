<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { usePasswordActions } from '~/composables/usePasswordActions'

definePageMeta({ layout: 'auth' })
const { t } = useI18n()
useHead({ title: () => `${t('auth.forgot.title')} · Koda` })
const { requestReset } = usePasswordActions()
const complete = ref(false)
const { defineField, errors, handleSubmit, isSubmitting } = useForm({
  validationSchema: toTypedSchema(z.object({ email: z.string().min(1, t('auth.validation.emailRequired')).email(t('auth.validation.emailInvalid')) })),
  initialValues: { email: '' },
})
const [email] = defineField('email')
const onSubmit = handleSubmit(async values => {
  try {
    await requestReset(values.email)
  } catch {
    // The same response is intentional for failures and unknown accounts.
  } finally {
    complete.value = true
  }
})
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-center text-2xl font-semibold">{{ t('auth.forgot.title') }}</h1>
    <p v-if="complete" role="status">{{ t('auth.forgot.checkEmail') }}</p>
    <form v-else class="space-y-4" @submit.prevent="onSubmit">
      <div class="space-y-2">
        <label for="email" class="text-sm font-medium">{{ t('auth.forgot.email') }}</label>
        <input id="email" :value="email" type="email" autocomplete="email" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="email = ($event.target as HTMLInputElement).value">
        <p v-if="errors.email" class="text-sm text-status-rejected">{{ errors.email }}</p>
      </div>
      <Button type="submit" :disabled="isSubmitting" class="w-full">{{ t('auth.forgot.submit') }}</Button>
    </form>
  </section>
</template>
