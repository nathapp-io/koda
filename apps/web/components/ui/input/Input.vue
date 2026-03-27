<template>
  <input
    :class="cn(
      'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      $attrs.class
    )"
    :value="modelValue"
    v-bind="forwardedAttrs"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '~/lib/utils'

defineProps<{
  modelValue?: string | number
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()

const attrs = useAttrs()

// Strip modelValue / onUpdate:modelValue from $attrs so they don't leak
// as raw HTML attributes on the native <input>
const forwardedAttrs = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { class: _c, modelValue: _mv, 'onUpdate:modelValue': _up, ...rest } = attrs
  return rest
})
</script>
