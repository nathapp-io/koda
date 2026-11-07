<script setup lang="ts">
import type { AgentJobResultDto } from '~/lib/fleet-types'
import { usd } from '~/lib/fleet-analytics-format'

const props = defineProps<{ agentResult: AgentJobResultDto | null | undefined }>()
const { t } = useI18n()
</script>

<template>
  <section class="space-y-3 rounded-md border border-border p-4" data-testid="fleet-job-agent-result">
    <h2 class="text-sm font-medium">{{ t('fleet.agentResult.title') }}</h2>
    <p v-if="!props.agentResult" class="text-sm text-muted-foreground" data-testid="fleet-agent-pending">
      {{ t('fleet.agentResult.pending') }}
    </p>
    <template v-else>
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <span data-testid="fleet-agent-status">{{ t(`fleet.agentResult.status.${props.agentResult.status}`) }}</span>
        <span v-if="props.agentResult.model" data-testid="fleet-agent-model">{{ t('fleet.agentResult.model', { model: props.agentResult.model }) }}</span>
        <span v-if="props.agentResult.costUsd !== undefined" data-testid="fleet-agent-cost">{{ usd(props.agentResult.costUsd) }}</span>
        <span v-else data-testid="fleet-agent-cost-unknown">{{ t('fleet.agentResult.costUnknown') }}</span>
      </div>
      <p v-if="props.agentResult.truncated" class="text-sm text-muted-foreground" data-testid="fleet-agent-truncated">
        {{ t('fleet.agentResult.truncated') }}
      </p>
      <div v-if="props.agentResult.output" class="space-y-1">
        <h3 class="text-sm font-medium">{{ t('fleet.agentResult.output') }}</h3>
        <pre class="overflow-x-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm" data-testid="fleet-agent-output">{{ props.agentResult.output }}</pre>
      </div>
      <ul v-if="props.agentResult.deniedAsks.length > 0" class="space-y-2" data-testid="fleet-agent-denied-asks">
        <li v-for="(ask, index) in props.agentResult.deniedAsks" :key="`${ask.kind}-${index}`" class="rounded border border-border p-2 text-sm">
          <template v-if="ask.kind === 'approval'">
            <span class="font-medium">{{ t('fleet.agentResult.approval', { tool: ask.tool }) }}</span>
            <p class="whitespace-pre-wrap text-muted-foreground">{{ ask.summary }}</p>
          </template>
          <p v-else class="whitespace-pre-wrap">{{ t('fleet.agentResult.question', { text: ask.text }) }}</p>
        </li>
      </ul>
      <p v-if="props.agentResult.deniedAsksTruncated" class="text-sm text-muted-foreground" data-testid="fleet-agent-asks-truncated">
        {{ t('fleet.agentResult.deniedAsksTruncated') }}
      </p>
    </template>
  </section>
</template>
