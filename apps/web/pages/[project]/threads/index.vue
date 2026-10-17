<script setup lang="ts">
import { MessagesSquare } from 'lucide-vue-next'
import { canWorkOnFleet } from '~/lib/fleet-jobs'

const route = useRoute()
const router = typeof useRouter === 'function' ? useRouter() : null
const slug = route.params.project as string
const { t } = useI18n()
const threadsList = useThreads(slug)
const roleRequest = useProjectViewerRole(slug)
const members = useProjectMemberNames(slug)
const role = computed(() => roleRequest.data.value ?? { canManage: false, viewerRole: null })
const canCreate = computed(() => canWorkOnFleet(role.value) && threadsList.threadsEnabled.value)
const pending = ref(true)
const loadFailed = ref(false)

/**
 * Bumped by every `loadPage()`. Only the newest read may settle `pending` or `loadFailed`: an
 * overtaken one that answers, or fails, after it must not hide the spinner or the list it shows
 * (koda#294, mirroring `pages/threads/index.vue`).
 */
let pageLoad = 0

async function loadPage(status: 'ACTIVE' | 'ARCHIVED' = threadsList.status.value): Promise<boolean> {
  const mine = ++pageLoad
  pending.value = true
  loadFailed.value = false
  try {
    // false when a newer selection overtook the thread read: its status is not the one on screen.
    const [applied] = await Promise.all([threadsList.load(status), members.load()])
    return applied
  } catch {
    if (mine === pageLoad) loadFailed.value = true
    return false
  } finally {
    if (mine === pageLoad) pending.value = false
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
        <h1 class="text-xl font-semibold">{{ t('fleet.threads.list.title') }}</h1>
      </div>
      <NuxtLink v-if="canCreate" :to="`/${slug}/threads/new`" class="inline-flex items-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
        {{ t('fleet.threads.list.newThread') }}
      </NuxtLink>
    </div>

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
    <FleetThreadsThreadListTable v-else :threads="threadsList.threads.value" :status="threadsList.status.value" :name-of="members.nameOf" :slug="slug" />
  </div>
</template>
