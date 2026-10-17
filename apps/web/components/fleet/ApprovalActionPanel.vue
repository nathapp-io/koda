<template>
  <div class="space-y-3 text-sm" data-testid="fleet-approval-action-panel">
    <p v-if="payload === null" class="text-status-rejected" data-testid="fleet-approval-action-failed">
      {{ t('fleet.approvals.assistant.previewFailed') }}
    </p>
    <template v-else>
      <p class="font-medium" data-testid="fleet-approval-action-tool">{{ t('fleet.approvals.summary.assistant', { tool: payload.tool }) }}</p>
      <NuxtLink :to="payload.threadPath" class="text-primary underline-offset-4 hover:underline" data-testid="fleet-approval-action-thread">
        {{ t('fleet.approvals.assistant.openThread') }}
      </NuxtLink>
      <p v-if="countdown !== null" class="text-muted-foreground" data-testid="fleet-approval-action-countdown">
        {{ t('fleet.approvals.assistant.expiresIn', { time: countdown }) }}
      </p>

      <p v-if="!canDecide" class="text-muted-foreground" data-testid="fleet-approval-action-requester-only">
        {{ t('fleet.approvals.assistant.requesterOnly') }}
      </p>
      <template v-else>
        <p v-if="previewState === 'loading'" class="text-muted-foreground" data-testid="fleet-approval-action-loading">
          {{ t('fleet.approvals.assistant.previewLoading') }}
        </p>
        <p v-else-if="previewState === 'gone'" class="text-muted-foreground" data-testid="fleet-approval-action-gone">
          {{ t('fleet.approvals.assistant.previewGone') }}
        </p>
        <p v-else-if="previewState === 'failed'" class="text-status-rejected" data-testid="fleet-approval-action-failed">
          {{ t('fleet.approvals.assistant.previewFailed') }}
        </p>
        <pre
          v-else-if="previewState === 'ready'"
          class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs"
          data-testid="fleet-approval-action-preview"
        >{{ previewText }}</pre>
        <div class="flex flex-wrap gap-2">
          <Button
            :disabled="!canApprove || busy"
            data-testid="fleet-approval-action-approve"
            @click="decide('approve')"
          >
            {{ t('fleet.approvals.assistant.approve') }}
          </Button>
          <Button variant="outline" :disabled="busy" data-testid="fleet-approval-action-reject" @click="decide('reject')">
            {{ t('fleet.approvals.assistant.reject') }}
          </Button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { assistantPayload, countdownText, secondsLeft, toActionBody } from '~/lib/fleet-approvals'
import type { DecideApprovalBody, FleetApprovalDto } from '~/lib/fleet-types'

// Mounted per `${id}:${status}:${detailVersion}` by FleetApprovalInbox (D242), so the preview below is read once.
const props = defineProps<{
  approval: FleetApprovalDto
  canDecide: boolean
  busy: boolean
  /** The inbox's 1-second clock (D292). */
  now: Date
}>()

const emit = defineEmits<{ (e: 'decide', body: DecideApprovalBody): void }>()

const { t } = useI18n()

const payload = computed(() => assistantPayload(props.approval))
/** `m:ss` left before the API denies the action; null when the approval carries no readable expiry. */
const countdown = computed(() => {
  const seconds = secondsLeft(props.approval.expiresAt, props.now)
  return seconds === null ? null : countdownText(seconds)
})

/**
 * 2aw-D9 / S5b-R5: Approve is only ever enabled by a preview the thread answered for THIS action, so the panel cannot
 * approve something the requester has not read. `idle` is what a viewer who cannot decide (or an unreadable payload)
 * stays in: nothing is fetched.
 */
type PreviewState = 'idle' | 'loading' | 'ready' | 'gone' | 'failed'
const previewState = ref<PreviewState>('idle')
const previewText = ref('')
const canApprove = computed(() => previewState.value === 'ready')

const preview = useActionPreview()
/** Answers a late read must not overwrite: the panel is remounted per approval, but the read can still outlive it. */
let latestLoad = 0

async function refresh(): Promise<void> {
  const action = payload.value
  if (!props.canDecide || action === null) {
    // Nothing may be fetched, and a read already in flight must not land on this state.
    latestLoad += 1
    previewState.value = 'idle'
    return
  }
  const loadId = ++latestLoad
  previewState.value = 'loading'
  try {
    const text = await preview.load(action.threadPath, action.actionId)
    if (loadId !== latestLoad) return
    if (text === null) {
      // The action is no longer pending on the thread: there is nothing exact left to approve.
      previewState.value = 'gone'
      return
    }
    previewText.value = text
    previewState.value = 'ready'
  } catch {
    // Shown, never toasted: the panel says previewFailed and the inbox keeps Approve disabled (2aw-D9).
    if (loadId !== latestLoad) return
    previewState.value = 'failed'
  }
}

watch(
  [() => props.canDecide, () => payload.value?.actionId ?? '', () => payload.value?.threadPath ?? ''],
  () => { void refresh() },
  { immediate: true },
)

function decide(decision: 'approve' | 'reject'): void {
  if (decision === 'approve' && !canApprove.value) return
  emit('decide', toActionBody(decision, ''))
}
</script>
