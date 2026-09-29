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
    <Button v-if="actions.has('verify')" class="w-full" @click="openDialog('verify')">{{ t('tickets.actions.verify') }}</Button>
    <Button v-if="actions.has('start')" class="w-full" @click="handleStart">{{ t('tickets.actions.start') }}</Button>
    <Button v-if="actions.has('fix')" class="w-full" @click="openDialog('fix')">{{ t('tickets.actions.submitFix') }}</Button>
    <template v-if="actions.has('verify-fix')">
      <Button class="w-full" @click="openDialog('verify-fix-approve')">{{ t('tickets.actions.approveFix') }}</Button>
      <Button class="w-full" variant="outline" @click="openDialog('verify-fix-fail')">{{ t('tickets.actions.failFix') }}</Button>
    </template>
    <Button v-if="actions.has('close')" class="w-full" variant="outline" @click="openDialog('close')">{{ t('tickets.actions.close') }}</Button>
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
