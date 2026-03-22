<script setup lang="ts">
import { ref } from 'vue'
import { toast } from 'vue-sonner'

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
    const message = error instanceof Error ? error.message : 'Action failed'
    toast.error(message)
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
  const body = comment.value ? { comment: comment.value } : {}
  closeDialog()
  await performAction(action, body)
}
</script>

<template>
  <div class="space-y-2">
    <!-- CREATED: Verify + Reject -->
    <template v-if="ticket.status === 'CREATED'">
      <Button class="w-full" @click="openDialog('verify')">Verify</Button>
      <Button class="w-full" variant="destructive" @click="openDialog('reject')">Reject</Button>
    </template>

    <!-- VERIFIED: Start -->
    <template v-else-if="ticket.status === 'VERIFIED'">
      <Button class="w-full" @click="handleStart">Start</Button>
    </template>

    <!-- IN_PROGRESS: Submit Fix + Reject -->
    <template v-else-if="ticket.status === 'IN_PROGRESS'">
      <Button class="w-full" @click="openDialog('fix')">Submit Fix</Button>
      <Button class="w-full" variant="destructive" @click="openDialog('reject')">Reject</Button>
    </template>

    <!-- VERIFY_FIX: Approve Fix + Fail Fix -->
    <template v-else-if="ticket.status === 'VERIFY_FIX'">
      <Button class="w-full" @click="handleApproveFix">Approve Fix</Button>
      <Button class="w-full" variant="outline" @click="openDialog('verify-fix-fail')">Fail Fix</Button>
    </template>

    <!-- CLOSED / REJECTED: no buttons -->
    <template v-else-if="ticket.status === 'CLOSED' || ticket.status === 'REJECTED'">
      <!-- terminal state — no actions available -->
    </template>

    <!-- Comment Dialog -->
    <Dialog :open="isOpen" @update:open="isOpen = $event">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add a comment</DialogTitle>
        </DialogHeader>
        <div class="space-y-4">
          <Textarea
            v-model="comment"
            placeholder="Enter a comment or reason..."
            rows="4"
          />
          <div class="flex justify-end gap-2">
            <Button variant="outline" @click="closeDialog">Cancel</Button>
            <Button @click="handleDialogSubmit">Confirm</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
