<script setup lang="ts">
import { DialogRoot, type DialogRootProps } from 'radix-vue'

const props = defineProps<DialogRootProps>()
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()
</script>

<template>
  <DialogRoot v-bind="props" @update:open="emit('update:open', $event)">
    <slot />
  </DialogRoot>
</template>
