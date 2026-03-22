<script setup lang="ts">
import { SelectContent, SelectViewport, SelectPortal, type SelectContentProps } from 'radix-vue'
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<SelectContentProps & { class?: string }>(), {
  position: 'popper',
})
</script>

<template>
  <SelectPortal>
    <SelectContent
      :class="cn(
        'relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        props.class
      )"
      v-bind="{ ...props, class: undefined }"
    >
      <SelectViewport class="p-1">
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
