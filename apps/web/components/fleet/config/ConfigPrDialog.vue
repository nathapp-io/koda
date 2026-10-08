<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NAX_CONFIG_LIMITS } from '@nathapp/fleet-protocol'

const props = defineProps<{ open: boolean; mode: 'edit' | 'regenerate'; busy: boolean }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void; (e: 'submit', body: { prTitle: string; prBody: string }): void }>()
const { t } = useI18n()

const title = ref('')
const body = ref('')
// A reopened dialog starts empty: a previous, abandoned title must not be resubmitted by accident.
watch(() => props.open, (open) => { if (open) { title.value = ''; body.value = '' } })

const error = computed((): string | null => {
  const trimmed = title.value.trim()
  if (trimmed.length > NAX_CONFIG_LIMITS.maxPrTitleChars) return t('fleet.config.prDialog.titleTooLong', { max: NAX_CONFIG_LIMITS.maxPrTitleChars })
  if (new TextEncoder().encode(body.value).length > NAX_CONFIG_LIMITS.maxPrBodyBytes) return t('fleet.config.prDialog.bodyTooLong')
  return null
})
const canSubmit = computed(() => title.value.trim().length > 0 && error.value === null && !props.busy)

function submit(): void {
  if (canSubmit.value) emit('submit', { prTitle: title.value.trim(), prBody: body.value })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ mode === 'edit' ? t('fleet.config.prDialog.editTitle') : t('fleet.config.prDialog.regenerateTitle') }}</DialogTitle>
        <DialogDescription>{{ mode === 'edit' ? t('fleet.config.prDialog.editHelp') : t('fleet.config.prDialog.regenerateHelp') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <Label for="config-pr-title">{{ t('fleet.config.prDialog.title') }}</Label>
        <Input id="config-pr-title" :model-value="title" data-testid="config-pr-title" @update:model-value="title = String($event)" />
        <Label for="config-pr-body">{{ t('fleet.config.prDialog.body') }}</Label>
        <Textarea id="config-pr-body" :model-value="body" rows="5" data-testid="config-pr-body" @update:model-value="body = String($event)" />
        <p v-if="error" class="text-sm text-status-rejected" role="alert" data-testid="config-pr-error">{{ error }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
        <Button :disabled="!canSubmit" data-testid="config-pr-submit" @click="submit()">{{ t('fleet.config.prDialog.submit') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
