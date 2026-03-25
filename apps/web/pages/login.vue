<template>
  <div class="space-y-6">
    <div class="text-center">
      <h2 class="text-3xl font-bold tracking-tight">{{ t('auth.login.title') }}</h2>
      <p class="mt-2 text-sm text-muted-foreground">
        {{ t('auth.login.subtitle') }}
      </p>
    </div>

    <form class="space-y-4" @submit="onSubmit">
      <FormField name="email" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>{{ t('auth.login.email') }}</FormLabel>
          <FormControl>
            <Input
              type="email"
              :placeholder="t('auth.login.emailPlaceholder')"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <FormField name="password" v-slot="{ componentField }">
        <FormItem>
          <FormLabel>{{ t('auth.login.password') }}</FormLabel>
          <FormControl>
            <Input
              type="password"
              :placeholder="t('auth.login.passwordPlaceholder')"
              v-bind="componentField"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      </FormField>

      <Button type="submit" class="w-full">
        {{ t('auth.login.signIn') }}
      </Button>
    </form>

    <p class="text-center text-sm text-muted-foreground">
      {{ t('auth.login.noAccount') }}
      <NuxtLink to="/register" class="font-medium text-primary hover:underline">
        {{ t('auth.login.createOne') }}
      </NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import { useForm } from 'vee-validate'
import { toTypedSchema } from '@vee-validate/zod'
import * as z from 'zod'
import { toast } from 'vue-sonner'
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'auth' })

const { t } = useI18n()

const formSchema = toTypedSchema(
  z.object({
    email: z.string().min(1, t('auth.validation.emailRequired')).email(t('auth.validation.emailInvalid')),
    password: z.string().min(8, t('auth.validation.passwordMin')),
  }) as any
)

const { handleSubmit } = useForm({
  validationSchema: formSchema,
  initialValues: { email: '', password: '' },
})

const auth = useAuth()

const onSubmit = handleSubmit(async (values) => {
  try {
    await auth.login(values)
    toast.success(t('toast.loggedIn'))
    navigateTo('/')
  } catch (err: unknown) {
    toast.error(extractApiError(err))
  }
})
</script>
