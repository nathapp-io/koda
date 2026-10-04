<script setup lang="ts">
import { formatBytes, type LogNotice } from '~/lib/fleet-log-view'

defineProps<{ notices: readonly LogNotice[]; timelineHref: string; truncatedAt: number }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="notices.length > 0" class="space-y-2" data-testid="fleet-log-notices">
    <p v-for="notice in notices" :key="notice.key" class="rounded-md border border-border px-3 py-2 text-sm" :data-testid="`fleet-log-notice-${notice.key}`">
      <template v-if="notice.key === 'incomplete'">{{ t('fleet.logs.notice.incomplete', { size: formatBytes(notice.size ?? 0) }) }}</template>
      <template v-else-if="notice.key === 'truncated'">{{ t('fleet.logs.notice.truncated', { size: formatBytes(truncatedAt) }) }}</template>
      <template v-else-if="notice.key === 'legacy'">
        {{ t('fleet.logs.notice.legacy') }}
        <NuxtLink :to="timelineHref" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-log-notice-timeline">{{ t('fleet.logs.legacyLink') }}</NuxtLink>
      </template>
      <template v-else>{{ t(`fleet.logs.notice.${notice.key}`) }}</template>
    </p>
  </div>
</template>
