<script setup lang="ts">
const props = defineProps<{ error: { statusCode: number; data?: { redirect?: string } | null } }>()
const { t } = useI18n()

/**
 * Review-1118 US-005 post-review: the retry must ask the API again. A protected route's outage page comes from Nuxt's
 * forced initial middleware pass, which leaves the failed URL as the current route; `clearError({ redirect })` is then
 * a duplicate router push that Vue Router drops without re-running the guard, so the same page would come back without
 * a fresh `/api/auth/me` probe. Clear Nuxt's error through its public API, then navigate the document so the guard
 * runs from scratch even if the router dropped the redirect as a duplicate.
 */
function retryTarget(): string {
  const redirect = props.error.data?.redirect
  // Only a local absolute path: the retry navigates the document itself, and a browser reads `//host` as another
  // origin and `\` as `/`, so anything else would be an open redirect.
  const localPath = /^\/[^\s\\]*$/.test(redirect ?? '') && !redirect?.startsWith('//')
  return localPath && redirect !== undefined ? redirect : '/'
}

async function retry() {
  const target = retryTarget()
  try {
    await clearError({ redirect: target })
  } catch {
    // A non-duplicate redirect can re-enter the still-failing client guard. The document retry below must still run.
  }
  const destination = new URL(target, window.location.href)
  // B4: `location.assign` is only a document navigation when the destination differs in its path or query. A
  // destination that matches the current path and query — the recorded redirect of a deep link that carried a
  // fragment — is a same-document fragment navigation: the browser updates the URL and scrolls, but no request is
  // made and the route guard never runs again, so the outage page would sit there. Write the destination fragment
  // onto the current entry, then reload the document so the guard probes the session from scratch.
  if (destination.pathname === window.location.pathname && destination.search === window.location.search) {
    if (destination.href !== window.location.href) {
      window.history.replaceState(window.history.state, '', destination.href)
    }
    window.location.reload()
    return
  }
  window.location.assign(target)
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
