<template>
  <div class="w-full max-w-md space-y-8">
    <div class="text-center">
      <h2 class="mt-6 text-3xl font-bold tracking-tight">{{ t('auth.register.title') }}</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        {{ t('auth.register.subtitle') }}
      </p>
    </div>

    <form class="space-y-4" @submit.prevent="onSubmit">
      <FormField v-slot="{ componentField }" name="name">
        <FormItem>
          <FormLabel>{{ t('auth.register.name') }}</FormLabel>
          <FormControl>
            <Input
              id="name"
              type="text"
              :placeholder="t('auth.register.namePlaceholder')"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-slot="{ componentField }" name="email">
        <FormItem>
          <FormLabel>{{ t('auth.register.email') }}</FormLabel>
          <FormControl>
            <Input
              id="email"
              type="email"
              :placeholder="t('auth.register.emailPlaceholder')"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField v-slot="{ componentField }" name="password">
        <FormItem>
          <FormLabel>{{ t('auth.register.password') }}</FormLabel>
          <FormControl>
            <Input
              id="password"
              type="password"
              :placeholder="t('auth.register.passwordPlaceholder')"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <Button type="submit" class="w-full">
        {{ t('auth.register.signUp') }}
      </Button>
    </form>

    <p class="text-center text-sm text-muted-foreground">
      {{ t('auth.register.hasAccount') }}
      <NuxtLink to="/login" class="font-medium text-primary hover:underline">
        {{ t('auth.register.signIn') }}
      </NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'auth' })

const { t } = useI18n()
const toast = useAppToast()

const formSchema = toTypedSchema(z.object({
  name: z.string().min(1, t('auth.validation.nameRequired') || 'Name is required'),
  email: z.string().min(1, t('auth.validation.emailRequired') || 'Email is required').email(t('auth.validation.emailInvalid') || 'Invalid email'),
  password: z.string().min(8, t('auth.validation.passwordMin') || 'Password must be at least 8 characters'),
}))

const { handleSubmit } = useForm({
  validationSchema: formSchema,
})

const auth = useAuth()

const onSubmit = handleSubmit(async (values) => {
  try {
    await auth.register({ name: values.name, email: values.email, password: values.password })
    toast.success(t('toast.loggedIn'))
    navigateTo('/')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>