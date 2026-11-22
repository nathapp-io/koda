<script setup lang="ts">
import { computed } from 'vue'
import { agentLabelKey } from '~/lib/thread-create'
import type { AgentChoice } from '~/lib/thread-create'
import { useLocalDates } from '~/lib/local-dates'

const props = defineProps<{
  choice: AgentChoice
  canRecheck: boolean
  /** This agent's own re-check is running: the button reads "re-checking" and is disabled. */
  rechecking: boolean
  /**
   * Another agent's re-check is running: the button is disabled but keeps its own copy. Only one
   * re-check runs at a time (`useAgentRecheck`), so a second click here could not start one anyway.
   */
  disabled?: boolean
}>()
const emit = defineEmits<{
  (event: 'recheck'): void
}>()
const i18n = useI18n()
const { t } = i18n
const dates = useLocalDates(i18n)

const reasonKey = computed(() => {
  const probe = props.choice.probe
  if (!probe) return ''
  const code = probe.code ?? (props.choice.reason === 'notLoggedIn' ? 'notLoggedIn' : 'unconfirmed')
  return `fleet.threads.new.agent.probe.${code}`
})
/** Disabled while this agent's own re-check runs, or while another agent's re-check is in flight. */
const recheckDisabled = computed(() => props.rechecking || props.disabled === true)
</script>

<template>
  <section
    v-if="choice.probe"
    class="space-y-2 rounded-md border border-border p-3 text-sm"
    :data-testid="`agent-readiness-${choice.agent}`"
  >
    <p class="font-medium">{{ t(agentLabelKey(choice.agent)) }}</p>
    <p class="text-muted-foreground">{{ t(reasonKey) }}</p>
    <p v-if="choice.probe.checkedAt" class="text-muted-foreground">
      {{ t('fleet.threads.new.agent.checkedAt', { time: dates.dateTime(choice.probe.checkedAt) }) }}
    </p>
    <button
      v-if="canRecheck"
      type="button"
      class="inline-flex items-center rounded-md border border-border px-3 py-1.5"
      :data-testid="`agent-recheck-${choice.agent}`"
      :disabled="recheckDisabled"
      @click="emit('recheck')"
    >
      {{ t(rechecking ? 'fleet.threads.new.agent.rechecking' : 'fleet.threads.new.agent.recheck') }}
    </button>
  </section>
</template>
