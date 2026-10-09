<script setup lang="ts">
import { toTypedSchema } from '@vee-validate/zod'
import { useForm } from 'vee-validate'
import * as z from 'zod'
import { extractApiError, extractErrorStatus } from '~/composables/useApi'

definePageMeta({ layout: 'auth' })

interface InvitePreview {
  projectName: string
  projectSlug: string
  email: string
  role?: string
  inviterName?: string | null
  expiresAt?: string
}

const route = useRoute()
const token = route.params.token as string
const { $api } = useApi()
const { isAuthenticated, acceptInvite } = useAuth()
const { t } = useI18n()
const toast = useAppToast()

const preview = ref<InvitePreview | null>(null)
const loading = ref(true)
const invalid = ref(false)
const accountExists = ref(false)

onMounted(async () => {
  try {
    preview.value = await $api.get<InvitePreview>(`/invites/${token}`)
  } catch (err: unknown) {
    if (extractErrorStatus(err) === 404) invalid.value = true
    else toast.error(extractApiError(err))
  } finally {
    loading.value = false
  }
})

const formSchema = toTypedSchema(z.object({
  name: z.string().min(1, t('invite.validation.nameRequired') || 'Name is required'),
  password: z.string().min(8, t('invite.validation.passwordMin') || 'Password must be at least 8 characters'),
}))

const { handleSubmit, defineField } = useForm({ validationSchema: formSchema })
const [name] = defineField('name')
const [password] = defineField('password')

const onSubmit = handleSubmit(async (values) => {
  accountExists.value = false
  try {
    await acceptInvite(token, { name: values.name, password: values.password })
    await navigateTo(`/${preview.value?.projectSlug ?? ''}`)
  } catch (err: unknown) {
    if (extractErrorStatus(err) === 409) accountExists.value = true
    else toast.error(extractApiError(err))
  }
})
</script>

<template>
  <div class="w-full max-w-md space-y-6">
    <LoadingState v-if="loading" />

    <div v-else-if="invalid" data-testid="invite-invalid" class="rounded-md border border-border p-6 text-center">
      <h2 class="text-xl font-semibold">{{ t('invite.title') }}</h2>
      <p class="mt-2 text-sm text-muted-foreground">{{ t('invite.invalid') }}</p>
    </div>

    <div v-else-if="isAuthenticated" data-testid="invite-signed-in" class="rounded-md border border-border p-6 text-center space-y-2">
      <h2 class="text-xl font-semibold">{{ t('invite.title') }}</h2>
      <p class="text-sm text-muted-foreground">{{ t('invite.signedIn') }}</p>
      <NuxtLink v-if="preview" :to="`/${preview.projectSlug}`" class="font-medium text-primary hover:underline">
        {{ preview.projectName }}
      </NuxtLink>
    </div>

    <template v-else>
      <div class="text-center">
        <h2 class="text-2xl font-bold tracking-tight">{{ t('invite.title') }}</h2>
        <p v-if="preview" class="mt-2 text-sm text-muted-foreground">
          {{ t('invite.subtitle', { projectName: preview.projectName }) }}
        </p>
      </div>

      <form data-testid="invite-accept-form" class="space-y-4" @submit.prevent="onSubmit">
        <div class="space-y-1">
          <Label for="name">{{ t('invite.name') }}</Label>
          <Input id="name" v-model="name" type="text" :placeholder="t('invite.namePlaceholder')" />
        </div>
        <div class="space-y-1">
          <Label for="password">{{ t('invite.password') }}</Label>
          <Input id="password" v-model="password" type="password" :placeholder="t('invite.passwordPlaceholder')" />
        </div>

        <p v-if="accountExists" data-testid="invite-account-exists" class="text-sm text-status-rejected">
          {{ t('invite.accountExists') }}
        </p>

        <Button type="submit" class="w-full">{{ t('invite.accept') }}</Button>
      </form>
    </template>
  </div>
</template>
