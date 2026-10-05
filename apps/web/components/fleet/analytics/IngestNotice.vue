<script setup lang="ts">
/** Spec §5.2, D401: runs in this window whose bundles are not analysed yet, or failed to ingest. */
defineProps<{ pending: number; failed: number; admin: boolean }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="pending + failed > 0" class="rounded-md border border-border p-3 text-sm" role="status" data-testid="fleet-analytics-ingest-notice">
    {{ t('fleet.analytics.ingestNotice', { pending, failed }) }}
    <NuxtLink v-if="admin" to="/admin/fleet/analytics" class="ml-2 text-primary underline-offset-4 hover:underline" data-testid="fleet-analytics-ingest-link">
      {{ t('fleet.analytics.ingestNoticeLink') }}
    </NuxtLink>
  </div>
</template>
