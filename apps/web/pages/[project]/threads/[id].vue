<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { isTurnRunning } from '~/lib/thread-view'

/**
 * Fleet S5a §4.62 (US-006): the thread detail page — the live header and transcript.
 *
 * The runner summaries (for the header's runner name and online dot) load with the page; the dot
 * follows those summaries and does not live-update. The tab title gains a `• ` prefix while a turn
 * runs (`isTurnRunning`). The header/timeline render once the thread has loaded; the composer,
 * session controls and question answering arrive in US-007.
 */
definePageMeta({ layout: 'default' })

const route = useRoute()
const slug = route.params.project as string
const threadId = route.params.id as string
const controller = useThread(slug, threadId)
const options = useFleetDispatchOptions(slug)
const auth = useAuth()

const isCreator = computed(() => controller.thread.value !== null && controller.thread.value.createdById === auth.user.value?.id)

useHead(() => ({
  title: isTurnRunning(controller.messages.value) ? `• ${controller.thread.value?.title ?? ''}` : controller.thread.value?.title ?? '',
}))

onMounted(() => {
  void Promise.all([controller.load(), options.load()])
  controller.start()
})
</script>

<template>
  <div class="space-y-5">
    <template v-if="controller.thread.value">
      <FleetThreadsThreadHeader :thread="controller.thread.value" :runners="options.runners.value" />
      <FleetThreadsThreadTimeline
        :thread="controller.thread.value"
        :messages="controller.messages.value"
        :is-creator="isCreator"
      />
    </template>
  </div>
</template>