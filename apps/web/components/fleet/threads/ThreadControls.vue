<script setup lang="ts">
import { computed, ref } from 'vue'
import type { SessionLabel } from '~/lib/thread-types'

/**
 * Fleet S5a §4.62 (US-007): the thread's session controls — End session for the creator
 * of a live session, Raise cap for the creator (a dialog validating the cap rule
 * 0.0001..10000 with at most four decimals), and Archive for the creator or a project
 * manager (a confirm dialog; hidden once archived).
 *
 * Contract: props `isCreator`, `canManage`, `sessionLabel: SessionLabel` and
 * `archived: boolean`; emits `endSession`, `raiseCap(value: number)` and `archive`.
 * A viewer who is neither creator nor project manager sees none of the three.
 */
const props = defineProps<{
  isCreator: boolean
  canManage: boolean
  sessionLabel: SessionLabel
  archived: boolean
}>()
const emit = defineEmits<{
  (event: 'endSession'): void
  (event: 'raiseCap', value: number): void
  (event: 'archive'): void
}>()
const { t } = useI18n()

const capOpen = ref(false)
const capValue = ref('')
const archiveOpen = ref(false)

const showEnd = computed(() => props.isCreator && props.sessionLabel === 'live')
const showRaise = computed(() => props.isCreator)
const showArchive = computed(() => !props.archived && (props.isCreator || props.canManage))

function onCapInput(event: Event): void {
  capValue.value = (event.target as HTMLInputElement).value
}

function openCap(): void {
  capOpen.value = true
}

function closeCap(): void {
  capOpen.value = false
}

function openArchive(): void {
  archiveOpen.value = true
}

function closeArchive(): void {
  archiveOpen.value = false
}

function setCapOpen(value: boolean): void {
  capOpen.value = value
}

function setArchiveOpen(value: boolean): void {
  archiveOpen.value = value
}

function confirmCap(): void {
  const value = Number(capValue.value)
  const valid = Number.isFinite(value)
    && value >= 0.0001 && value <= 10_000
    && Math.abs(value * 10_000 - Math.round(value * 10_000)) < 1e-6
  if (!valid) return
  emit('raiseCap', value)
  capOpen.value = false
}

function confirmArchive(): void {
  emit('archive')
  archiveOpen.value = false
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2" data-testid="thread-controls">
    <Button
      v-if="showEnd"
      type="button"
      variant="outline"
      data-testid="thread-end-session"
      @click="emit('endSession')"
    >{{ t('fleet.threads.controls.endSession') }}</Button>
    <Button
      v-if="showRaise"
      type="button"
      variant="outline"
      data-testid="thread-raise-cap"
      @click="openCap"
    >{{ t('fleet.threads.controls.raiseCap') }}</Button>
    <Button
      v-if="showArchive"
      type="button"
      variant="outline"
      data-testid="thread-archive"
      @click="openArchive"
    >{{ t('fleet.threads.controls.archive') }}</Button>

    <Dialog :open="capOpen" @update:open="setCapOpen">
      <DialogContent v-if="capOpen" class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t('fleet.threads.controls.raiseCapTitle') }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <Label>{{ t('fleet.threads.controls.capLabel') }}</Label>
          <Input
            :model-value="capValue"
            type="number"
            min="0.0001"
            max="10000"
            step="0.0001"
            data-testid="thread-cap-input"
            @input="onCapInput"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="closeCap">{{ t('common.cancel') }}</Button>
          <Button type="button" data-testid="thread-cap-confirm" @click="confirmCap">{{ t('fleet.threads.controls.confirm') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="archiveOpen" @update:open="setArchiveOpen">
      <DialogContent v-if="archiveOpen" class="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{{ t('fleet.threads.controls.archiveTitle') }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t('fleet.threads.controls.archiveBody') }}</p>
        <DialogFooter>
          <Button type="button" variant="outline" @click="closeArchive">{{ t('common.cancel') }}</Button>
          <Button type="button" data-testid="thread-archive-confirm" @click="confirmArchive">{{ t('fleet.threads.controls.confirm') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>