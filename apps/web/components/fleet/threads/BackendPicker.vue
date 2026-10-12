<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ models: string[]; model: string; effort: string }>()
const emit = defineEmits<{
  (event: 'update:model', value: string): void
  (event: 'update:effort', value: string): void
}>()
const { t } = useI18n()
const modelOptions = computed(() => props.models.map(model => ({ value: model, label: model })))
const effortOptions = computed(() => [
  { value: '', label: t('fleet.threads.new.effortDefault') },
  ...(['low', 'medium', 'high', 'xhigh'] as const).map(value => ({ value, label: t(`fleet.threads.new.effort.${value}`) })),
])
</script>

<template>
  <div class="space-y-3">
    <div v-if="models.length === 0" class="text-sm text-muted-foreground">{{ t('fleet.threads.new.noBackend') }}</div>
    <div v-else class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-2">
        <Label>{{ t('fleet.threads.new.model') }}</Label>
        <select :value="model" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @change="emit('update:model', ($event.target as HTMLSelectElement).value)">
          <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
      <div class="space-y-2">
        <Label>{{ t('fleet.threads.new.effortLabel') }}</Label>
        <select :value="effort" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" @change="emit('update:effort', ($event.target as HTMLSelectElement).value)">
          <option v-for="option in effortOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
    </div>
  </div>
</template>
