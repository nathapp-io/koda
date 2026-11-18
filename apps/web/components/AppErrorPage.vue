<script setup lang="ts">
const props = defineProps<{ error: { statusCode: number; data?: { redirect?: string } | null } }>()
const { t } = useI18n()

function retry() {
  clearError({ redirect: props.error.data?.redirect ?? '/' })
}

function goHome() {
  clearError({ redirect: '/' })
}
</script>

<template>
  <main class="flex min-h-screen items-center justify-center bg-background px-6 text-center">
    <section class="max-w-lg space-y-4">
      <template v-if="error.statusCode === 503">
        <h1 class="text-3xl font-semibold">{{ t('errorPage.unavailable.title') }}</h1>
        <p class="text-muted-foreground">{{ t('errorPage.unavailable.body') }}</p>
        <button data-testid="error-page-retry" class="rounded-md bg-primary px-4 py-2 text-primary-foreground" @click="retry">
          {{ t('errorPage.retry') }}
        </button>
      </template>
      <template v-else>
        <h1 class="text-3xl font-semibold">{{ t('errorPage.generic.title', { statusCode: error.statusCode }) }}</h1>
        <button data-testid="error-page-home" class="rounded-md bg-primary px-4 py-2 text-primary-foreground" @click="goHome">
          {{ t('errorPage.home') }}
        </button>
      </template>
    </section>
  </main>
</template>
