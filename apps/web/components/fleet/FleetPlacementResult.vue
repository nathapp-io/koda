<script setup lang="ts">
import { codeLabel } from '~/lib/fleet-i18n'
import type { DispatchResultDto } from '~/lib/fleet-types'

defineProps<{
  slug: string
  result: DispatchResultDto
  runnerName: (id: string | null) => string | null
  /** The job page shows a requeue's placement; it does not link to itself. */
  hideOpenLink?: boolean
}>()
const { t, te } = useI18n()
</script>

<template>
  <div class="space-y-3 rounded-md border border-border p-4" data-testid="placement-result">
    <p v-if="result.placement.assigned" class="font-medium" data-testid="placement-assigned">
      {{ t('fleet.dispatch.result.assigned', { runner: runnerName(result.placement.runnerId) ?? '-' }) }}
    </p>
    <p v-else class="font-medium" data-testid="placement-queued">{{ t('fleet.dispatch.result.queued') }}</p>
    <div v-if="result.placement.misfits.length > 0" class="space-y-1">
      <p class="text-sm text-muted-foreground">{{ t('fleet.dispatch.result.misfitsTitle') }}</p>
      <ul class="space-y-1 text-sm">
        <li v-for="misfit in result.placement.misfits" :key="misfit.runnerId" data-testid="placement-misfit">
          <span class="font-medium">{{ misfit.name }}</span>: {{ codeLabel(t, te, 'fleet.misfit', misfit.reason) }}
        </li>
      </ul>
    </div>
    <NuxtLink
      v-if="!hideOpenLink"
      :to="`/${slug}/fleet/jobs/${result.job.id}`"
      class="inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
      data-testid="placement-open-job"
    >
      {{ t('fleet.dispatch.result.openJob') }}
    </NuxtLink>
  </div>
</template>
