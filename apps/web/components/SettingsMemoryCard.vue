<script setup lang="ts">
import { extractApiError } from '~/composables/useApi'
import { useMemoryWriteMode } from '~/composables/useMemoryWriteMode'

const props = defineProps<{ slug: string }>()
const { t } = useI18n()
const { permissions } = useProjectPermissions(props.slug)
const canManage = computed(() => permissions.value.has('approval.policy.manage'))
const { state, loading, load, setProposal, setDirect } = useMemoryWriteMode(props.slug)
const selected = ref<'direct' | 'proposal'>('direct')
const saving = ref(false)
const errorMessage = ref<string | null>(null)

async function refresh(): Promise<void> {
  try {
    const result = await load()
    selected.value = result.agentPolicy && result.agentPolicy.mode !== 'none' ? 'proposal' : 'direct'
    errorMessage.value = null
  } catch (error) {
    errorMessage.value = extractApiError(error)
  }
}

onMounted(refresh)

async function choose(mode: 'direct' | 'proposal'): Promise<void> {
  if (!canManage.value || saving.value || selected.value === mode) return
  const lastReported = selected.value
  selected.value = mode
  errorMessage.value = null
  saving.value = true
  try {
    if (mode === 'proposal') await setProposal()
    else await setDirect()
    const policy = state.value?.agentPolicy
    selected.value = policy && policy.mode !== 'none' ? 'proposal' : 'direct'
  } catch (error) {
    selected.value = lastReported
    errorMessage.value = extractApiError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section data-testid="settings-memory-card" class="space-y-3">
    <h2 class="text-lg font-semibold">{{ t('memory.settings.title') }}</h2>
    <p class="text-sm text-muted-foreground">{{ t('memory.settings.description') }}</p>
    <LoadingState v-if="loading" />
    <ErrorState v-else-if="!state" @retry="refresh" />
    <div v-else class="flex flex-wrap gap-3">
      <Button
        type="button"
        variant="outline"
        data-testid="memory-mode-direct"
        :aria-pressed="selected === 'direct'"
        :disabled="!canManage || saving"
        @click="choose('direct')"
      >
        {{ t('memory.settings.direct') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        data-testid="memory-mode-proposal"
        :aria-pressed="selected === 'proposal'"
        :disabled="!canManage || saving"
        @click="choose('proposal')"
      >
        {{ t('memory.settings.proposal') }}
      </Button>
    </div>
    <p v-if="errorMessage" role="alert" data-testid="memory-mode-error" class="text-sm text-status-rejected">
      {{ errorMessage }}
    </p>
  </section>
</template>
