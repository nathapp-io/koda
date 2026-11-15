<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError, extractErrorStatus } from '~/composables/useApi'
import { usePasswordActions } from '~/composables/usePasswordActions'

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
    if (extractErrorStatus(err) === 403 || (err !== null && typeof err === 'object' && 'code' in err && err.code === 40003)) {
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
        <input id="currentPassword" :value="currentPassword" type="password" autocomplete="current-password" class="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" @input="currentPassword = ($event.target as HTMLInputElement).value">
        <p v-if="errors.currentPassword" class="text-sm text-status-rejected">{{ errors.currentPassword }}</p>
      </div>
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
      <Button type="submit" :disabled="isSubmitting">{{ t('auth.account.submit') }}</Button>
    </form>
  </section>
</template>
