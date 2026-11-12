<script setup lang="ts">
import { FILTER_CONTROL_CLASS } from '~/lib/form-control'
import { computed } from 'vue'
import { agentLabelKey, agentReasonKey, effortLabel } from '~/lib/thread-create'
import type { AgentChoice } from '~/lib/thread-create'

/**
 * The agent/model/effort picker of the new-thread forms (thread-agents-modes US-011).
 *
 * The agent select lists Native, Claude Code, Codex and Cursor from `eligibleAgents`; an agent no
 * eligible runner can start is disabled and says why ("Not installed", "Not logged in", "Login not
 * verified"). The model and effort selects list the *chosen* agent's own values, so switching agent
 * switches them. An ACP agent may offer no model at all: its empty entry is the agent's default, which
 * the create body then omits (the API takes an acp backend without a model).
 */
const props = defineProps<{
  agents: AgentChoice[]
  agent: string
  model: string
  effort: string
}>()
const emit = defineEmits<{
  (event: 'update:agent', value: string): void
  (event: 'update:model', value: string): void
  (event: 'update:effort', value: string): void
}>()
const { t } = useI18n()

/** The chosen agent's entry; the first available one stands in until the form has picked. */
const chosen = computed<AgentChoice | undefined>(() =>
  props.agents.find(choice => choice.agent === props.agent)
  ?? props.agents.find(choice => choice.available)
  ?? props.agents[0])

const agentOptions = computed(() => props.agents.map(choice => ({
  value: choice.agent,
  // The reason rides in the option's own label: a disabled <option> cannot be hovered or focused.
  label: choice.reason === null
    ? t(agentLabelKey(choice.agent))
    : `${t(agentLabelKey(choice.agent))} — ${t(agentReasonKey(choice.reason))}`,
  disabled: !choice.available,
})))

const modelOptions = computed(() => {
  const models = (chosen.value?.models ?? []).map(model => ({ value: model, label: model }))
  // An ACP agent may advertise no model at all (a successful probe can return an empty list, and the
  // API's acp backend takes no model): the empty entry is the agent's own default.
  if (chosen.value === undefined || chosen.value.agent === 'native') return models
  return [{ value: '', label: t('fleet.threads.new.agent.defaultModel') }, ...models]
})
const effortOptions = computed(() => [
  { value: '', label: t('fleet.threads.new.effortDefault') },
  ...(chosen.value?.efforts ?? []).map(value => ({ value, label: effortLabel(value, t) })),
])
/** Native needs a model id to offer anything; an ACP agent is usable on its default. */
const hasBackendControls = computed(() => modelOptions.value.length > 0)
</script>

<template>
  <div class="space-y-3">
    <div v-if="agents.length > 0" class="space-y-2">
      <Label for="thread-backend-agent">{{ t('fleet.threads.new.agent.label') }}</Label>
      <select id="thread-backend-agent" :value="agent" :class="[FILTER_CONTROL_CLASS, 'w-full']" data-testid="thread-new-agent" @change="emit('update:agent', ($event.target as HTMLSelectElement).value)">
        <option v-for="option in agentOptions" :key="option.value" :value="option.value" :disabled="option.disabled">{{ option.label }}</option>
      </select>
    </div>
    <div v-if="!hasBackendControls" class="text-sm text-muted-foreground">{{ t('fleet.threads.new.noBackend') }}</div>
    <div v-else class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label for="thread-backend-model">{{ t('fleet.threads.new.model') }}</Label>
        <select id="thread-backend-model" :value="model" :class="[FILTER_CONTROL_CLASS, 'w-full']" data-testid="thread-new-model" @change="emit('update:model', ($event.target as HTMLSelectElement).value)">
          <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
      <div class="space-y-2">
        <Label for="thread-backend-effort">{{ t('fleet.threads.new.effortLabel') }}</Label>
        <select id="thread-backend-effort" :value="effort" :class="[FILTER_CONTROL_CLASS, 'w-full']" data-testid="thread-new-effort" @change="emit('update:effort', ($event.target as HTMLSelectElement).value)">
          <option v-for="option in effortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
    </div>
  </div>
</template>
