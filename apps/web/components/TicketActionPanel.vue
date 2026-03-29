<script setup lang="ts">
import { ref } from 'vue'
import { extractApiError } from '~/composables/useApi'

interface Ticket {
  id: string
  ref: string
  status: 'CREATED' | 'VERIFIED' | 'IN_PROGRESS' | 'VERIFY_FIX' | 'CLOSED' | 'REJECTED'
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
const pendingAction = ref<string | null>(null)

function openDialog(action: string) {
  pendingAction.value = action
  comment.value = ''
  isOpen.value = true
}

function closeDialog() {
  isOpen.value = false
  pendingAction.value = null
  comment.value = ''
}

const baseUrl = computed(() => `/projects/${props.projectSlug}/tickets/${props.ticket.ref}`)

async function performAction(action: string, body: Record<string, unknown> = {}) {
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

async function handleApproveFix() {
  await performAction('verify-fix-approve')
}

async function handleDialogSubmit() {
  const action = pendingAction.value
  if (!action) return
  const body = comment.value ? { body: comment.value } : {}
  closeDialog()
  await performAction(action, body)
}
</script>

<template>
  <div class="space-y-2">
    <!-- CREATED: Verify + Reject -->
    <template v-if="ticket.status === 'CREATED'">
      <Button class="w-full" @click="openDialog('verify')">{{ t('tickets.actions.verify') }}</Button>
      <Button class="w-full" variant="destructive" @click="openDialog('reject')">{{ t('tickets.actions.reject') }}</Button>
    </template>

    <!-- VERIFIED: Start -->
    <template v-else-if="ticket.status === 'VERIFIED'">
      <Button class="w-full" @click="handleStart">{{ t('tickets.actions.start') }}</Button>
    </template>

    <!-- IN_PROGRESS: Submit Fix + Reject -->
    <template v-else-if="ticket.status === 'IN_PROGRESS'">
      <Button class="w-full" @click="openDialog('fix')">{{ t('tickets.actions.submitFix') }}</Button>
      <Button class="w-full" variant="destructive" @click="openDialog('reject')">{{ t('tickets.actions.reject') }}</Button>
    </template>

    <!-- VERIFY_FIX: Approve Fix + Fail Fix -->
    <template v-else-if="ticket.status === 'VERIFY_FIX'">
      <Button class="w-full" @click="handleApproveFix">{{ t('tickets.actions.approveFix') }}</Button>
      <Button class="w-full" variant="outline" @click="openDialog('verify-fix-fail')">{{ t('tickets.actions.failFix') }}</Button>
    </template>

    <!-- CLOSED / REJECTED: no buttons -->
    <template v-else-if="ticket.status === 'CLOSED' || ticket.status === 'REJECTED'">
      <!-- terminal state — no actions available -->
    </template>

    <!-- Comment Dialog -->
    <Dialog :open="isOpen" @update:open="isOpen = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t('common.addComment') }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea
            v-model="comment"
            :placeholder="t('common.commentPlaceholder')"
            rows="4"
          />
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="closeDialog">{{ t('common.cancel') }}</Button>
            <Button @click="handleDialogSubmit">{{ t('common.confirm') }}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
