<script setup lang="ts">
import { ingestVariant, timeText } from '~/lib/fleet-analytics-format'
import type { IngestRowDto } from '~/lib/fleet-analytics-types'
import { codeLabel } from '~/lib/fleet-i18n'

/** Spec §5.3, D397: ingest health with a per-row Re-run. Ids are text: the ingest list carries no slug. */
defineProps<{ rows: readonly IngestRowDto[]; busyJobId: string | null }>()
const emit = defineEmits<{ rerun: [jobId: string] }>()
const { t, te } = useI18n()
const statusLabel = (status: string): string => codeLabel(t, te, 'fleet.analytics.ingestStatus', status)
</script>

<template>
  <div class="overflow-x-auto">
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
          <td class="py-1 font-mono text-xs break-all">{{ row.jobId }} <span class="text-muted-foreground">#{{ row.leaseEpoch }}</span></td>
          <td class="py-1 font-mono text-xs break-all">{{ row.projectId }}</td>
          <td class="py-1 text-right tabular-nums">{{ row.attempts }}</td>
          <td class="max-w-xs py-1"><span class="block truncate" :title="row.error ?? ''">{{ row.error ?? '-' }}</span></td>
          <td class="py-1 whitespace-nowrap">{{ timeText(row.updatedAt) }}</td>
          <td class="py-1 text-right">
            <Button variant="outline" size="sm" :disabled="busyJobId === row.jobId" data-testid="fleet-ingest-rerun" @click="emit('rerun', row.jobId)">{{ t('fleet.analytics.ingest.rerun') }}</Button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
