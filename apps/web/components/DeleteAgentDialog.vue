<template>
  <Dialog :open="open" @update:open="$emit('update:open', $event)">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ t('agents.deleteAgent.title') }}</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <p class="text-sm text-muted-foreground">
          {{ t('agents.deleteAgent.confirm', { name: agent.name }) }}
        </p>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" @click="$emit('update:open', false)">
            {{ t('common.cancel') }}
          </Button>
          <Button variant="destructive" data-testid="agent-delete-confirm" @click="handleDelete" :disabled="isSubmitting">
            {{ isSubmitting ? t('agents.deleteAgent.deleting') : t('agents.actions.delete') }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { apiPath } from '~/lib/api-path'
import { extractApiError } from '~/composables/useApi'

/** The agent fields this dialog renders; the legacy role list is not one of them (Permissions P1 US-011). */
interface Agent {
  id: string
  name: string
  slug: string
  capabilities: string[]
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE'
}

const props = defineProps<{
  open: boolean
  agent: Agent
}>()

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void
  (e: 'deleted'): void
}>()

const { t } = useI18n()
const toast = useAppToast()
const { $api } = useApi()

const isSubmitting = ref(false)

async function handleDelete() {
  isSubmitting.value = true
  try {
    await $api.delete(apiPath`/agents/${props.agent.slug}`)
    toast.success(t('agents.toast.deleted'))
    emit('deleted')
    emit('update:open', false)
  } catch (err: unknown) {
    // The API owns the rules (open tickets block a delete, who may delete an agent); show what it said.
    toast.error(extractApiError(err))
  } finally {
    isSubmitting.value = false
  }
}
</script>
