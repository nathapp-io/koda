<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useFleetFlows } from '~/composables/useFleetFlows'
import { isLiveFlow, type FleetFlowDto } from '~/lib/fleet-flows'
import { flowStartState } from '~/lib/fleet-flow-start'
import type { ThreadDto } from '~/lib/thread-types'

const props = defineProps<{ slug: string; thread: ThreadDto }>()
const { permissions } = useProjectPermissions(props.slug)
const flows = useFleetFlows(props.slug)
const records = ref<FleetFlowDto[]>([])
const { t } = useI18n()

const fetchThreadFlows = (): void => {
  void flows.list(1, props.thread.id)
    .then(page => { records.value = page.records })
    .catch(() => { records.value = [] })
}

watch(() => permissions.value.has('fleet.flow.read'), (allowed) => {
  if (allowed) fetchThreadFlows()
  else records.value = []
})
onMounted(() => {
  if (permissions.value.has('fleet.flow.read')) fetchThreadFlows()
})

const state = computed(() => flowStartState(props.thread, {
  canCreate: permissions.value.has('fleet.flow.create'),
  liveFlow: records.value.some(flow => isLiveFlow(flow.state)),
}))
</script>

<template>
  <div v-if="state.visible" class="space-y-2">
    <Button :disabled="!state.enabled" data-testid="start-flow-button">
      {{ t('fleet.flows.start.button') }}
    </Button>
    <p v-if="state.reason === 'notPublished'" class="text-sm text-muted-foreground">
      {{ t('fleet.flows.start.blocked.notPublished') }}
    </p>
    <p v-else-if="state.reason === 'flowLive'" class="text-sm text-muted-foreground">
      {{ t('fleet.flows.start.blocked.flowLive') }}
    </p>
  </div>
</template>
