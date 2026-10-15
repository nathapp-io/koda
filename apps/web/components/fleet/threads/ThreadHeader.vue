<script setup lang="ts">
import { computed } from 'vue'
import { tokenText } from '~/lib/fleet-analytics-format'
import type { FleetRunnerSummary } from '~/lib/fleet-types'
import type { ThreadDetailDto } from '~/lib/thread-types'
import { costText, sessionLabel } from '~/lib/thread-view'

/**
 * Fleet S5a §4.62 (US-006): the thread's live header — identity, runner with an online dot from
 * the runner summaries loaded with the page (no live-updating stream of its own), skills, money
 * exactly as received (`costText`, A7) and the total token spend.
 */
const props = defineProps<{ thread: ThreadDetailDto; runners: FleetRunnerSummary[] }>()
const { t } = useI18n()

const runner = computed(() => props.runners.find(r => r.id === props.thread.runnerId) ?? null)
const skillNames = computed(() => props.thread.skills.flatMap(source => source.skills.map(skill => skill.name)))
const totalTokens = computed(() => (props.thread.tokens ? props.thread.tokens.input + props.thread.tokens.output : null))

/** A PROJECT thread has no feature branch: the header shows the scope label instead (S5b 1a-R3). */
const featureLabel = computed(() =>
  props.thread.kind === 'PROJECT' ? t('fleet.threads.kind.project') : `feat/${props.thread.feature}`,
)
</script>

<template>
  <div class="space-y-2" data-testid="thread-header">
    <div class="flex flex-wrap items-center gap-2">
      <h1 class="text-xl font-semibold">{{ props.thread.title }}</h1>
      <span class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{{ featureLabel }}</span>
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ props.thread.backend.kind }}<span v-if="props.thread.backend.model"> · {{ props.thread.backend.model }}</span></span>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span v-if="runner" class="inline-flex items-center gap-1.5">
        <span class="h-2 w-2 rounded-full" :class="runner.online ? 'bg-status-done' : 'bg-status-todo'" aria-hidden="true" />
        <span>{{ runner.name }}</span>
        <span class="text-xs">{{ t(runner.online ? 'fleet.common.online' : 'fleet.common.offline') }}</span>
      </span>
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs">{{ t(`fleet.threads.session.${sessionLabel(props.thread)}`) }}</span>
      <span class="font-mono text-xs">{{ costText(props.thread) }}</span>
      <span v-if="totalTokens !== null" class="font-mono text-xs">{{ tokenText(totalTokens) }} {{ t('fleet.threads.detail.tokens') }}</span>
      <span
        v-for="(name, index) in skillNames"
        :key="`${index}-${name}`"
        class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
      >{{ name }}</span>
    </div>
  </div>
</template>