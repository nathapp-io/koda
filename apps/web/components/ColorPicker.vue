<script setup lang="ts">
import { normalizeHexColor } from '~/utils/color'

const props = defineProps<{
  modelValue: string
  defaultColor?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const colorValue = computed(() => props.modelValue || props.defaultColor || '#6366F1')

function handleColorInput(e: Event) {
  const target = e.target as HTMLInputElement
  emit('update:modelValue', normalizeHexColor(target.value))
}

function handleTextInput(e: Event) {
  const target = e.target as HTMLInputElement
  emit('update:modelValue', normalizeHexColor(target.value))
}
</script>

<template>
  <div class="flex items-center gap-2">
    <Input
      type="color"
      class="w-12 h-10 p-1 cursor-pointer"
      :value="colorValue"
      @change="handleColorInput"
    />
    <Input
      class="w-32 font-mono"
      :value="colorValue"
      @input="handleTextInput"
      placeholder="#6366F1"
    />
    <span
      class="inline-block w-8 h-8 rounded-sm border"
      :style="{ backgroundColor: colorValue }"
    />
  </div>
</template>
