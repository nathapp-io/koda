<script setup lang="ts">
import { MessagesSquare } from 'lucide-vue-next'

definePageMeta({ layout: 'default' })

/**
 * The personal thread list (fleet S5b 1d, S5b-R12). It mirrors `pages/[project]/threads/index.vue`
 * over the top-level `/threads` route: every row is the signed-in user's own WORKSPACE thread, so
 * the page needs no project slug and no membership question — only the kill switch the API reports.
 */
const route = useRoute()
const router = typeof useRouter === 'function' ? useRouter() : null
const { t } = useI18n()
const auth = useAuth()
const threadsList = useWorkspaceThreads()
const pending = ref(true)
const loadFailed = ref(false)

/** Every row of this list is the caller's own thread, so the creator column answers their name. */
const nameOf = (userId: string): string => auth.user.value?.name ?? auth.user.value?.email ?? userId

async function loadPage(status: 'ACTIVE' | 'ARCHIVED' = threadsList.status.value): Promise<boolean> {
  pending.value = true
  loadFailed.value = false
  try {
    await threadsList.load(status)
    return true
  } catch {
    loadFailed.value = true
    return false
  } finally {
    pending.value = false
  }
}

async function selectStatus(status: 'ACTIVE' | 'ARCHIVED'): Promise<void> {
  if (await loadPage(status)) {
    await router?.replace({ query: { ...(route.query ?? {}), status: status === 'ACTIVE' ? undefined : status } })
  }
}

onMounted(() => {
  void loadPage(route.query?.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE')
})
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="flex items-center gap-2">
        <MessagesSquare class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <h1 class="text-xl font-semibold">{{ t('fleet.threads.workspace.title') }}</h1>
      </div>
      <NuxtLink v-if="threadsList.threadsEnabled.value" to="/threads/new" class="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        {{ t('fleet.threads.list.newThread') }}
      </NuxtLink>
    </div>

    <p v-if="!threadsList.threadsEnabled.value" class="text-sm text-muted-foreground">{{ t('fleet.threads.workspace.disabled') }}</p>

    <div class="inline-flex rounded-md border border-border p-1" role="group" :aria-label="t('fleet.threads.list.status')">
      <button
        type="button"
        class="rounded px-3 py-1.5 text-sm"
        :class="threadsList.status.value === 'ACTIVE' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="threadsList.status.value === 'ACTIVE'"
        @click="selectStatus('ACTIVE')"
      >{{ t('fleet.threads.list.active') }}</button>
      <button
        type="button"
        class="rounded px-3 py-1.5 text-sm"
        :class="threadsList.status.value === 'ARCHIVED' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
        :aria-pressed="threadsList.status.value === 'ARCHIVED'"
        @click="selectStatus('ARCHIVED')"
      >{{ t('fleet.threads.list.archived') }}</button>
    </div>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="loadFailed" @retry="loadPage()" />
    <FleetThreadsThreadListTable v-else :threads="threadsList.threads.value" :status="threadsList.status.value" :name-of="nameOf" base-path="/threads" />
  </div>
</template>
