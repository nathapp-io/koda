<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>Rotate API Key</DialogTitle>
      </DialogHeader>

      <form v-if="!apiKey" @submit="onConfirm" class="space-y-4">
        <p class="text-sm text-muted-foreground">
          Are you sure you want to rotate the API key for {{ agent.name }}? The old key will become invalid.
        </p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            Cancel
          </Button>
          <Button type="submit" :disabled="isSubmitting">
            {{ isSubmitting ? 'Rotating...' : 'Confirm' }}
          </Button>
        </div>
      </form>

      <div v-if="apiKey" class="space-y-4">
        <div class="flex gap-2">
          <Input :value="apiKey" readonly class="flex-1 font-mono text-sm" />
          <Button @click="copyToClipboard">{{ copyButtonText }}</Button>
        </div>
        <p class="text-sm text-muted-foreground">
          Copy this API key now. It will not be shown again.
        </p>
        <div class="flex justify-end">
          <Button @click="handleDone">Done</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

interface Agent {
  id: string
  name: string
  slug: string
  roles: string[]
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

const props = defineProps<{
  open: boolean
  agent: Agent
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'rotated'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { $api } = useApi()

const apiKey = ref<string | null>(null)
const copyButtonText = ref('Copy')
const isSubmitting = ref(false)

async function onConfirm() {
  isSubmitting.value = true
  try {
    const response = await $api.post('/agents/' + props.agent.slug + '/rotate-key', {}) as { apiKey: string }
    apiKey.value = response.apiKey
  } catch {
    toast.error(t('agents.rotateKey.failed'))
  } finally {
    isSubmitting.value = false
  }
}

async function copyToClipboard() {
  if (!apiKey.value) return
  await navigator.clipboard.writeText(apiKey.value)
  copyButtonText.value = 'Copied!'
  setTimeout(revertCopyButton, 2000)
}

function revertCopyButton() {
  copyButtonText.value = 'Copy'
}

function handleDone() {
  emit('rotated')
  emit('update:open', false)
  apiKey.value = null
}
</script>
