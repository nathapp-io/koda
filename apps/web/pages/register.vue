<template>
  <div class="flex min-h-screen items-center justify-center bg-background">
    <div class="w-full max-w-md space-y-8">
      <div class="text-center">
        <h2 class="mt-6 text-3xl font-bold tracking-tight">{{ t('auth.register.title') }}</h2>
        <p class="mt-2 text-sm text-muted-foreground">
          {{ t('auth.register.subtitle') }}
        </p>
      </div>

      <div v-if="error" class="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
        {{ error }}
      </div>

      <form class="space-y-4" @submit.prevent="handleRegister">
        <div>
          <label for="name" class="block text-sm font-medium">
            {{ t('auth.register.name') }}
          </label>
          <input
            id="name"
            v-model="name"
            type="text"
            required
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            :placeholder="t('auth.register.namePlaceholder')"
          />
        </div>

        <div>
          <label for="email" class="block text-sm font-medium">
            {{ t('auth.register.email') }}
          </label>
          <input
            id="email"
            v-model="email"
            type="email"
            required
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            :placeholder="t('auth.register.emailPlaceholder')"
          />
        </div>

        <div>
          <label for="password" class="block text-sm font-medium">
            {{ t('auth.register.password') }}
          </label>
          <input
            id="password"
            v-model="password"
            type="password"
            required
            class="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            :placeholder="t('auth.register.passwordPlaceholder')"
          />
        </div>

        <button
          type="submit"
          class="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {{ t('auth.register.signUp') }}
        </button>
      </form>

      <p class="text-center text-sm text-muted-foreground">
        {{ t('auth.register.hasAccount') }}
        <NuxtLink to="/login" class="font-medium text-primary hover:underline">
          {{ t('auth.register.signIn') }}
        </NuxtLink>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'

definePageMeta({ layout: 'auth' })

const { t } = useI18n()

const name = ref('')
const email = ref('')
const password = ref('')
const error = ref('')

const auth = useAuth()

const handleRegister = async () => {
  error.value = ''
  try {
    await auth.register({ name: name.value, email: email.value, password: password.value })
    navigateTo('/')
  } catch (err: unknown) {
    error.value = extractApiError(err)
  }
}
</script>
