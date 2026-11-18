<script setup lang="ts">
const props = defineProps<{ error: { statusCode: number; data?: { redirect?: string } | null } }>()
const { t } = useI18n()

/**
 * Review-1118 US-005 post-review: the retry must ask the API again. A protected route's outage page comes from Nuxt's
 * forced initial middleware pass, which leaves the failed URL as the current route; `clearError({ redirect })` is then
 * a duplicate router push that Vue Router drops without re-running the guard, so the same page would come back without
 * a fresh `/api/auth/me` probe. A document navigation clears the error state and runs the guard from scratch.
 */
function retryTarget(): string {
  const redirect = props.error.data?.redirect
  // Only a local absolute path: the retry navigates the document itself, and a browser reads `//host` as another
  // origin and `\` as `/`, so anything else would be an open redirect.
  const localPath = /^\/[^\s\\]*$/.test(redirect ?? '') && !redirect?.startsWith('//')
  return localPath && redirect !== undefined ? redirect : '/'
}

function retry() {
  window.location.assign(retryTarget())
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
