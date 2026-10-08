<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { validateNewPath } from '~/lib/nax-config'

const props = defineProps<{ open: boolean; targets: string[]; existing: string[] }>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void; (e: 'create', path: string): void }>()
const { t } = useI18n()

const path = ref('')
watch(() => props.open, (open) => { if (open) path.value = '' })

const problem = computed(() => (path.value.trim() === '' ? null : validateNewPath(path.value.trim(), props.existing)))
const canCreate = computed(() => path.value.trim() !== '' && problem.value === null)

function create(): void {
  if (canCreate.value) emit('create', path.value.trim())
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ t('fleet.config.newFile.title') }}</DialogTitle>
        <DialogDescription>{{ t('fleet.config.newFile.help') }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-3">
        <div class="flex flex-wrap gap-2">
          <Button v-for="target in targets" :key="target" size="sm" variant="outline" data-testid="new-file-target" @click="path = target">
            <span class="font-mono text-xs">{{ target }}</span>
          </Button>
        </div>
        <Label for="new-file-path">{{ t('fleet.config.newFile.path') }}</Label>
        <Input id="new-file-path" :model-value="path" class="font-mono" data-testid="new-file-path" @update:model-value="path = String($event)" />
        <p v-if="problem" class="text-sm text-status-rejected" role="alert" data-testid="new-file-error">{{ t(`fleet.config.newFile.${problem}`) }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t('common.cancel') }}</Button>
        <Button :disabled="!canCreate" data-testid="new-file-create" @click="create()">{{ t('fleet.config.newFile.create') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
