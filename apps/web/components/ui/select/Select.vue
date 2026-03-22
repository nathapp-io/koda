<script setup lang="ts">
import { SelectRoot, type SelectRootProps } from 'radix-vue'

const props = defineProps<SelectRootProps>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
</script>

<template>
  <SelectRoot v-bind="props" @update:model-value="emit('update:modelValue', $event)">
    <slot />
  </SelectRoot>
</template>
