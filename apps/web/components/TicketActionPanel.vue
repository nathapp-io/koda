<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'

type TicketAction = 'verify' | 'start' | 'fix' | 'verify-fix' | 'reject' | 'close'
type DialogAction = 'verify' | 'fix' | 'reject' | 'close' | 'verify-fix-approve' | 'verify-fix-fail'

interface Ticket {
  id: string
  ref: string
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
  /** Computed by the API for the current user (M25); absent means no actions. */
  allowedActions?: TicketAction[]
  [key: string]: unknown
}

const props = defineProps<{
  ticket: Ticket
  projectSlug: string
}>()

const emit = defineEmits<{
  (e: 'transition'): void
}>()

const { $api } = useApi()
const { t } = useI18n()
const toast = useAppToast()

const isOpen = ref(false)
const comment = ref('')
const pendingAction = ref<DialogAction | null>(null)

const actions = computed(() => new Set(props.ticket.allowedActions ?? []))
const canSubmit = computed(() => comment.value.trim().length > 0)

type PanelAction = DialogAction | 'start'

const PRIMARY_ORDER: PanelAction[] = ['verify', 'start', 'fix', 'verify-fix-approve']

function actionLabel(action: PanelAction): string {
  switch (action) {
    case 'verify': return t('tickets.actions.verify')
    case 'start': return t('tickets.actions.start')
    case 'fix': return t('tickets.actions.submitFix')
    case 'verify-fix-approve': return t('tickets.actions.approveFix')
    case 'verify-fix-fail': return t('tickets.actions.failFix')
    case 'close': return t('tickets.actions.close')
    default: return action
  }
}

function openCloseDialog() {
  openDialog('close')
}

function openApproveFixDialog() {
  openDialog('verify-fix-approve')
}

const primaryAction = computed<PanelAction | null>(() => {
  for (const action of PRIMARY_ORDER) {
    if (action === 'verify-fix-approve') {
      if (actions.value.has('verify-fix')) return action
    } else if (actions.value.has(action)) {
      return action
    }
  }
  return null
})

const primaryRun = computed<() => void>(() => {
  const action = primaryAction.value
  if (action === 'start') return handleStart
  if (action === 'verify-fix-approve') return openApproveFixDialog
  return () => openDialog((action ?? 'verify') as DialogAction)
})

const secondaryActions = computed<Array<{ key: DialogAction; label: string; run: () => void }>>(() => {
  const items: Array<{ key: DialogAction; label: string; run: () => void }> = []
  if (actions.value.has('verify-fix') && primaryAction.value !== 'verify-fix-approve') {
    items.push({ key: 'verify-fix-approve', label: actionLabel('verify-fix-approve'), run: openApproveFixDialog })
  }
  if (actions.value.has('verify-fix')) {
    items.push({ key: 'verify-fix-fail', label: actionLabel('verify-fix-fail'), run: () => openDialog('verify-fix-fail') })
  }
  if (actions.value.has('close')) {
    items.push({ key: 'close', label: actionLabel('close'), run: openCloseDialog })
  }
  return items
})
const dialogTitle = computed(() =>
  pendingAction.value === 'close' ? t('tickets.actions.closeReasonTitle') : t('common.addComment'),
)

function openDialog(action: DialogAction) {
  pendingAction.value = action
  comment.value = ''
  isOpen.value = true
}

function closeDialog() {
  isOpen.value = false
  pendingAction.value = null
  comment.value = ''
}

const baseUrl = computed(() => apiPath`/projects/${props.projectSlug}/tickets/${props.ticket.ref}`)

async function performAction(action: DialogAction | 'start', body: Record<string, unknown> = {}) {
  try {
    if (action === 'verify-fix-approve') {
      await $api.post(`${baseUrl.value}/verify-fix?approve=true`, body)
    } else if (action === 'verify-fix-fail') {
      await $api.post(`${baseUrl.value}/verify-fix?approve=false`, body)
    } else {
      await $api.post(`${baseUrl.value}/${action}`, body)
    }
    emit('transition')
  } catch (error: unknown) {
    toast.error(extractApiError(error))
  }
}

async function handleStart() {
  await performAction('start')
}

async function handleDialogSubmit() {
  const action = pendingAction.value
  if (!action || !canSubmit.value) return
  const body = { body: comment.value.trim() }
  closeDialog()
  await performAction(action, body)
}
</script>

<template>
  <div class="space-y-2">
    <Button v-if="primaryAction" class="w-full" @click="primaryRun()">
      {{ actionLabel(primaryAction) }}
    </Button>
    <Button
      v-for="item in secondaryActions"
      :key="item.key"
      class="w-full"
      variant="outline"
      @click="item.run()"
    >
      {{ item.label }}
    </Button>
    <Button v-if="actions.has('reject')" class="w-full" variant="destructive" @click="openDialog('reject')">{{ t('tickets.actions.reject') }}</Button>

    <Dialog :open="isOpen" @update:open="isOpen = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ dialogTitle }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea
            v-model="comment"
            :placeholder="t('common.commentPlaceholder')"
            rows="4"
          />
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="closeDialog">{{ t('common.cancel') }}</Button>
            <Button :disabled="!canSubmit" @click="handleDialogSubmit">{{ t('common.confirm') }}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
