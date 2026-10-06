<script setup lang="ts">
import type { PanelStatus } from '~/composables/useAnalyticsPanel'

/** D393: one analytics panel; its own loading, empty and error states, so one failure never blanks the page. */
defineProps<{ title: string; status: PanelStatus; testid: string; emptyText?: string }>()
const emit = defineEmits<{ retry: [] }>()
const { t } = useI18n()
</script>

<template>
  <section class="space-y-3 rounded-md border border-border p-4" :data-testid="testid" :data-status="status">
    <h2 class="text-sm font-medium">{{ title }}</h2>
    <p v-if="status === 'loading' || status === 'idle'" class="text-sm text-muted-foreground" :data-testid="`${testid}-loading`">{{ t('common.loading') }}</p>
    <div v-else-if="status === 'error'" class="flex flex-wrap items-center gap-3 text-sm" role="alert" :data-testid="`${testid}-error`">
      <span class="text-status-rejected">{{ t('fleet.analytics.panelError') }}</span>
      <Button variant="outline" size="sm" :data-testid="`${testid}-retry`" @click="emit('retry')">{{ t('common.retry') }}</Button>
    </div>
    <p v-else-if="status === 'empty'" class="text-sm text-muted-foreground" :data-testid="`${testid}-empty`">{{ emptyText ?? t('fleet.analytics.panelEmpty') }}</p>
    <slot v-else />
  </section>
</template>
