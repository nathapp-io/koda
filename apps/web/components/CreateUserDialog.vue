<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('admin.users.form.title') }}</DialogTitle>
      </DialogHeader>

      <form class="space-y-4" @submit="onSubmit">
        <FormField v-slot="{ componentField }" name="email">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.email') }}</FormLabel>
            <FormControl><Input type="email" v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="name">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.name') }}</FormLabel>
            <FormControl><Input v-bind="componentField" /></FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="password">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.password') }}</FormLabel>
            <FormControl><Input type="password" autocomplete="new-password" v-bind="componentField" /></FormControl>
            <p class="text-xs text-muted-foreground">{{ t('admin.users.form.passwordHint') }}</p>
            <FormMessage />
          </FormItem>
        </FormField>

        <FormField v-slot="{ componentField }" name="role">
          <FormItem>
            <FormLabel>{{ t('admin.users.form.role') }}</FormLabel>
            <FormControl>
              <select v-bind="componentField" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option value="MEMBER">{{ t('admin.users.roles.MEMBER') }}</option>
                <option value="ADMIN">{{ t('admin.users.roles.ADMIN') }}</option>
              </select>
            </FormControl>
            <FormMessage />
          </FormItem>
        </FormField>

        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">{{ t('common.cancel') }}</Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? t('admin.users.form.creating') : t('admin.users.form.submit') }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

defineProps<{ open: boolean }>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'created'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { createUser } = useAdminUsers()

// Mirrors the API's PASSWORD_COMPLEXITY so the user sees the rule before submitting.
const PASSWORD_COMPLEXITY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/

const formSchema = toTypedSchema(z.object({
  email: z.string().min(1, t('auth.validation.emailRequired')).email(t('auth.validation.emailInvalid')),
  name: z.string().min(1, t('auth.validation.nameRequired')),
  password: z.string().min(8, t('auth.validation.passwordMin')).regex(PASSWORD_COMPLEXITY, t('admin.users.form.passwordComplexity')),
  role: z.enum(['MEMBER', 'ADMIN']),
}))

const { handleSubmit, isSubmitting, resetForm } = useForm({
  validationSchema: formSchema,
  initialValues: { email: '', name: '', password: '', role: 'MEMBER' as const },
})

const onSubmit = handleSubmit(async (values) => {
  try {
    await createUser(values)
    toast.success(t('admin.users.toast.created'))
    emit('created')
    emit('update:open', false)
    resetForm()
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
