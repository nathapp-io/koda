<script setup lang="ts">
import { RadioGroupRoot, type RadioGroupRootProps } from 'radix-vue'

const props = defineProps<RadioGroupRootProps>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
</script>

<template>
  <RadioGroupRoot v-bind="props" @update:model-value="emit('update:modelValue', $event)">
    <slot />
  </RadioGroupRoot>
</template>
