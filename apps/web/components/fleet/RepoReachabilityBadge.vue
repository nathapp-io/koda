<template>
  <Badge v-if="!state || state.status === 'checking'" variant="outline">{{ t('fleet.repos.reach.checking') }}</Badge>
  <Badge v-else-if="state.status === 'error'" variant="outline" :title="state.message">{{ t('fleet.repos.reach.error') }}</Badge>
  <Badge v-else-if="state.result.reachable" variant="secondary">{{ t('fleet.repos.reach.ok') }}</Badge>
  <Badge v-else variant="destructive" :title="reasonText(state.result.reason)">
    {{ t('fleet.repos.reach.failed') }}: {{ reasonText(state.result.reason) }}
  </Badge>
</template>

<script setup lang="ts">
import type { RepoCheckState } from '~/composables/useFleetRepos'

defineProps<{ state: RepoCheckState | undefined }>()

const { t, te } = useI18n()

/** Translated reason (plan D126); an unknown code is shown as sent. */
function reasonText(reason: string | null): string {
  if (!reason) return t('fleet.common.unknown')
  const key = `fleet.repoReason.${reason}`
  return te(key) ? t(key) : reason
}
</script>
