<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { extractApiError } from '~/composables/useApi'
import { useAppToast } from '~/composables/useAppToast'
import { useFleetFlows } from '~/composables/useFleetFlows'
import type { FlowStartBody } from '~/lib/fleet-flow-start-body'
import type { FlowWrite } from '~/composables/useFleetFlows'
import { isLiveFlow, type FleetFlowDto } from '~/lib/fleet-flows'
import { flowStartState } from '~/lib/fleet-flow-start'
import type { ThreadDetailDto } from '~/lib/thread-types'

const props = defineProps<{ slug: string; thread: ThreadDetailDto }>()
const { permissions } = useProjectPermissions(props.slug)
const flows = useFleetFlows(props.slug)
const records = ref<FleetFlowDto[]>([])
const { t } = useI18n()
const auth = useAuth()
const toast = useAppToast()
const dialogOpen = ref(false)
const submitting = ref(false)
const showApprovalLink = ref(false)

async function submit(payload: unknown): Promise<void> {
  const body = payload as FlowStartBody
  if (submitting.value) return
  submitting.value = true
  showApprovalLink.value = false
  try {
    const result: FlowWrite = await flows.createFromThread(props.thread.id, body)
    if (result.kind === 'pending') {
      dialogOpen.value = false
      showApprovalLink.value = true
      toast.success(t('fleet.flows.toast.approvalRequested'))
    }
    else {
      await navigateTo(`/${props.slug}/flows/${result.flow.id}`)
    }
  }
  catch (error: unknown) {
    toast.error(extractApiError(error))
  }
  finally {
    submitting.value = false
  }
}

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
    <Button :disabled="!state.enabled" data-testid="start-flow-button" @click="dialogOpen = true">
      {{ t('fleet.flows.start.button') }}
    </Button>
    <FleetThreadsThreadStartFlowDialog
      :open="dialogOpen"
      :thread="thread"
      :viewer-id="auth.user.value?.id ?? ''"
      @update:open="dialogOpen = $event"
      @submit="submit"
    />
    <NuxtLink v-if="showApprovalLink" class="underline" :to="`/${slug}/approvals`">
      {{ t('fleet.flows.start.openApprovals') }}
    </NuxtLink>
    <p v-if="state.reason === 'notPublished'" class="text-sm text-muted-foreground">
      {{ t('fleet.flows.start.blocked.notPublished') }}
    </p>
    <p v-else-if="state.reason === 'flowLive'" class="text-sm text-muted-foreground">
      {{ t('fleet.flows.start.blocked.flowLive') }}
    </p>
  </div>
</template>
