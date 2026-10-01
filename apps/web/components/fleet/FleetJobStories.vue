<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import { storyRows } from '~/lib/fleet-jobs'
import type { FleetJobDto } from '~/lib/fleet-types'

const props = defineProps<{ job: FleetJobDto }>()
const { t, te } = useI18n()

const rows = computed(() => storyRows(props.job))
const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.storyStatus', status)
</script>

<template>
  <section v-if="rows.length > 0" class="space-y-2" data-testid="fleet-job-stories">
    <h2 class="text-sm font-medium">{{ t('fleet.jobs.detail.stories.title') }}</h2>
    <ul class="divide-y divide-border rounded-md border border-border text-sm">
      <li
        v-for="row in rows"
        :key="row.id"
        class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
        :class="row.current ? 'bg-muted' : ''"
        data-testid="fleet-job-story"
        :data-story="row.id"
        :data-current="row.current ? 'true' : 'false'"
        :aria-current="row.current ? 'step' : undefined"
      >
        <span class="font-mono text-xs">{{ row.id }}</span>
        <span class="min-w-0 flex-1 break-words">{{ row.title }}</span>
        <span v-if="row.current && row.phase" class="text-xs text-muted-foreground" data-testid="fleet-job-story-phase">{{ t('fleet.jobs.detail.stories.phase', { phase: row.phase }) }}</span>
        <span class="text-xs text-muted-foreground">{{ t('fleet.jobs.detail.stories.attempts', { count: row.attempts }) }}</span>
        <Badge :variant="row.variant">{{ statusLabel(row.status) }}</Badge>
      </li>
    </ul>
    <p v-if="job.storiesTruncated" class="text-xs text-muted-foreground" data-testid="fleet-job-stories-truncated">
      {{ t('fleet.jobs.detail.stories.truncated', { count: rows.length }) }}
    </p>
  </section>
</template>
