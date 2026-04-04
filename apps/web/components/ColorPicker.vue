<template>
  <div class="flex items-center gap-2">
    <input
      type="color"
      :value="displayColor"
      class="h-10 w-10 cursor-pointer rounded border border-input p-0.5"
      @input="onColorInput"
    />
    <input
      type="text"
      :value="displayColor"
      class="flex h-10 w-20 rounded-md border border-input bg-background px-3 py-2 text-sm uppercase ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      @input="onHexInput"
      placeholder="#FFFFFF"
    />
    <div
      id="color-swatch"
      class="h-10 w-10 rounded-md border border-input"
      :style="{ 'background-color': displayColor }"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  modelValue?: string
  defaultColor?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function normalizeHex(color: string): string {
  let hex = color.trim()
  if (!hex.startsWith('#')) {
    hex = '#' + hex
  }
  return hex.toUpperCase()
}

function isValidHex(hex: string): boolean {
  return /^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex)
}

const displayColor = computed(() => {
  return normalizeHex(props.modelValue || '') || normalizeHex(props.defaultColor || '') || '#6366F1'
})

function onColorInput(event: Event) {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', normalizeHex(target.value))
}

function onHexInput(event: Event) {
  const target = event.target as HTMLInputElement
  const value = target.value.trim()
  if (isValidHex(value)) {
    emit('update:modelValue', normalizeHex(value))
  }
}
</script>
