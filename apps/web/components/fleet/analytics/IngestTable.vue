<script setup lang="ts">
import { ingestVariant } from '~/lib/fleet-analytics-format'
import { useLocalDates } from '~/lib/local-dates'
import type { IngestProject, IngestRowDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/** Spec §5.3, D397: ingest health with a per-row Re-run. Ids are text: the ingest list carries no slug. */
const props = withDefaults(defineProps<{ rows: readonly IngestRowDto[]; busyJobId: string | null; projects?: readonly IngestProject[] }>(), { projects: () => [] })
const projectFor = (projectId: string): IngestProject | undefined => props.projects.find((project) => project.id === projectId)
const shortJobId = (jobId: string): string => jobId.slice(0, 8)
const emit = defineEmits<{ rerun: [jobId: string] }>()
const i18n = useI18n()
const { t, te } = i18n
const dates = useLocalDates(i18n)
const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.analytics.ingestStatus', status)
</script>

<template>
  <div class="relative overflow-x-auto">
    <table class="w-full text-sm" data-testid="fleet-ingest-table">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.status') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.job') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.project') }}</th>
          <th scope="col" class="py-1 text-right font-normal">{{ t('fleet.analytics.ingest.attempts') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.error') }}</th>
          <th scope="col" class="py-1 font-normal">{{ t('fleet.analytics.ingest.updated') }}</th>
          <th scope="col" class="py-1"><span class="sr-only">{{ t('fleet.analytics.ingest.rerun') }}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id" data-testid="fleet-ingest-row" :data-job="row.jobId" :data-status="row.status">
          <td class="py-1"><Badge :variant="ingestVariant(row.status)">{{ statusLabel(row.status) }}</Badge></td>
          <td class="py-1 font-mono text-xs break-all">
            <span v-if="projectFor(row.projectId)" :title="row.jobId"><NuxtLink :to="`/${projectFor(row.projectId)?.slug}/fleet/jobs/${row.jobId}`">{{ shortJobId(row.jobId) }}</NuxtLink></span>
            <span v-else :title="row.jobId">{{ shortJobId(row.jobId) }}</span>
            <span class="text-muted-foreground"> #{{ row.leaseEpoch }}</span>
          </td>
          <td class="py-1 font-mono text-xs break-all">{{ projectFor(row.projectId)?.name ?? row.projectId }}</td>
          <td class="py-1 text-right tabular-nums">{{ row.attempts }}</td>
          <td class="max-w-xs py-1"><span class="block truncate" :title="row.error ?? ''">{{ row.error ?? '-' }}</span></td>
          <td class="py-1 whitespace-nowrap">{{ dates.dateTime(row.updatedAt) }}</td>
          <td class="py-1 text-right">
            <Button variant="outline" size="sm" :disabled="busyJobId === row.jobId" data-testid="fleet-ingest-rerun" @click="emit('rerun', row.jobId)">{{ t('fleet.analytics.ingest.rerun') }}</Button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
