<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'
import { isCurrentPasswordWrong, usePasswordActions } from '~/composables/usePasswordActions'

const { t } = useI18n()
const toast = useAppToast()
const { changePassword } = usePasswordActions()
useHead({ title: () => `${t('auth.account.title')} · Koda` })
const schema = toTypedSchema(z.object({
  currentPassword: z.string().min(1, t('auth.account.currentRequired')),
  newPassword: z.string().min(8, t('auth.account.minimum')),
  confirmNewPassword: z.string(),
}).refine(values => values.newPassword === values.confirmNewPassword, {
  path: ['confirmNewPassword'], message: t('auth.account.mismatch'),
}))
const { defineField, errors, handleSubmit, resetForm, setFieldError, isSubmitting } = useForm({
  validationSchema: schema,
  initialValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
})
const [currentPassword] = defineField('currentPassword')
const [newPassword] = defineField('newPassword')
const [confirmNewPassword] = defineField('confirmNewPassword')
const onSubmit = handleSubmit(async values => {
  try {
    await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword })
    toast.success(t('auth.account.success'))
    resetForm()
  } catch (err: unknown) {
    if (isCurrentPasswordWrong(err)) {
      setFieldError('currentPassword', t('auth.account.currentPasswordWrong'))
    } else {
      toast.error(extractApiError(err))
    }
  }
})
</script>

<template>
  <section class="max-w-md space-y-6">
    <h1 class="text-2xl font-semibold">{{ t('auth.account.title') }}</h1>
    <form class="space-y-4" @submit.prevent="onSubmit">
      <div class="space-y-2">
        <label for="currentPassword" class="text-sm font-medium">{{ t('auth.account.currentPassword') }}</label>
        <input id="currentPassword" :aria-invalid="errors.currentPassword ? 'true' : undefined" :aria-describedby="errors.currentPassword ? 'currentPassword-error' : undefined" :value="currentPassword" type="password" autocomplete="current-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="currentPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.currentPassword" id="currentPassword-error" class="text-sm text-status-rejected">{{ errors.currentPassword }}</p>
      </div>
      <div class="space-y-2">
        <label for="newPassword" class="text-sm font-medium">{{ t('auth.account.newPassword') }}</label>
        <input id="newPassword" :aria-invalid="errors.newPassword ? 'true' : undefined" :aria-describedby="errors.newPassword ? 'newPassword-error' : undefined" :value="newPassword" type="password" autocomplete="new-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="newPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.newPassword" id="newPassword-error" class="text-sm text-status-rejected">{{ errors.newPassword }}</p>
      </div>
      <div class="space-y-2">
        <label for="confirmNewPassword" class="text-sm font-medium">{{ t('auth.account.confirmNewPassword') }}</label>
        <input id="confirmNewPassword" :aria-invalid="errors.confirmNewPassword ? 'true' : undefined" :aria-describedby="errors.confirmNewPassword ? 'confirmNewPassword-error' : undefined" :value="confirmNewPassword" type="password" autocomplete="new-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="confirmNewPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.confirmNewPassword" id="confirmNewPassword-error" class="text-sm text-status-rejected">{{ errors.confirmNewPassword }}</p>
      </div>
      <Button type="submit" :disabled="isSubmitting">{{ t('auth.account.submit') }}</Button>
    </form>
  </section>
</template>
