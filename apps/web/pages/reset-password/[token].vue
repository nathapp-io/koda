<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError, extractErrorStatus } from '~/composables/useApi'
import { usePasswordActions } from '~/composables/usePasswordActions'

definePageMeta({ layout: 'auth' })
const { t } = useI18n()
useHead({ title: () => `${t('auth.reset.title')} · Koda` })
const route = useRoute()
const toast = useAppToast()
const { confirmReset } = usePasswordActions()
const invalid = ref(false)
const schema = toTypedSchema(z.object({
  newPassword: z.string().min(8, t('auth.account.minimum')),
  confirmNewPassword: z.string(),
}).refine(values => values.newPassword === values.confirmNewPassword, {
  path: ['confirmNewPassword'], message: t('auth.account.mismatch'),
}))
const { defineField, errors, handleSubmit, isSubmitting } = useForm({
  validationSchema: schema, initialValues: { newPassword: '', confirmNewPassword: '' },
})
const [newPassword] = defineField('newPassword')
const [confirmNewPassword] = defineField('confirmNewPassword')
const onSubmit = handleSubmit(async values => {
  try {
    await confirmReset(String(route.params.token), values.newPassword)
    await navigateTo('/login?reset=1')
  } catch (err: unknown) {
    if (extractErrorStatus(err) === 400 || (err !== null && typeof err === 'object' && 'code' in err && (err.code === -2 || err.code === 400))) {
      invalid.value = true
    } else {
      toast.error(extractApiError(err))
    }
  }
})
</script>

<template>
  <section class="space-y-6">
    <h1 class="text-center text-2xl font-semibold">{{ t('auth.reset.title') }}</h1>
    <div v-if="invalid" role="alert" class="space-y-4">
      <p>{{ t('auth.reset.invalid') }}</p>
      <NuxtLink to="/forgot-password" class="text-link hover:underline">{{ t('auth.reset.tryAgain') }}</NuxtLink>
    </div>
    <form v-else class="space-y-4" @submit.prevent="onSubmit">
      <div class="space-y-2">
        <label for="newPassword" class="text-sm font-medium">{{ t('auth.account.newPassword') }}</label>
        <input id="newPassword" :value="newPassword" type="password" autocomplete="new-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="newPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.newPassword" class="text-sm text-status-rejected">{{ errors.newPassword }}</p>
      </div>
      <div class="space-y-2">
        <label for="confirmNewPassword" class="text-sm font-medium">{{ t('auth.account.confirmNewPassword') }}</label>
        <input id="confirmNewPassword" :value="confirmNewPassword" type="password" autocomplete="new-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="confirmNewPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.confirmNewPassword" class="text-sm text-status-rejected">{{ errors.confirmNewPassword }}</p>
      </div>
      <Button type="submit" :disabled="isSubmitting" class="w-full">{{ t('auth.reset.submit') }}</Button>
    </form>
  </section>
</template>
