<template>
  <textarea
    :class="cn(
      'flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      $attrs.class as string
    )"
    :value="modelValue"
    v-bind="forwardedAttrs"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { cn } from '~/lib/utils'

// All attrs go through forwardedAttrs (so class is applied once, via cn).
defineOptions({ inheritAttrs: false })

defineProps<{
  modelValue?: string
}>()

defineEmits<{
  'update:modelValue': [value: string]
}>()

const attrs = useAttrs()

// Strip modelValue / onUpdate:modelValue from $attrs so they don't leak
// as raw HTML attributes on the native <textarea>
const forwardedAttrs = computed(() => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { class: _c, modelValue: _mv, 'onUpdate:modelValue': _up, ...rest } = attrs
  return rest
})
</script>
