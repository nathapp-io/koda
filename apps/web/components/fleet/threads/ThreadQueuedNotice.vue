<script setup lang="ts">
import type { ThreadDetailDto } from '~/lib/thread-types'

defineProps<{ thread: ThreadDetailDto }>()
const { t } = useI18n()
</script>

<template>
  <section v-if="thread.queuedTurn" role="status" data-testid="thread-queued-notice" class="rounded-md border border-border p-3">
    <h2>{{ t('fleet.threads.queued.title') }}</h2>
    <p>{{ t(`fleet.threads.queued.verdict.${thread.queuedTurn.verdict}`) }}</p>
    <ul>
      <li v-for="(item, index) in thread.queuedTurn.reasons" :key="`${item.runnerName}-${item.reason}-${index}`">
        {{ t('fleet.threads.queued.reasonOn', { runner: item.runnerName, reason: t(`fleet.misfit.${item.reason}`) }) }}
      </li>
    </ul>
  </section>
</template>
