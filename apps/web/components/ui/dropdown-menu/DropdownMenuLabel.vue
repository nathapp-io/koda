<script setup lang="ts">
import { DropdownMenuLabel } from 'radix-vue'
import { cn } from '~/lib/utils'

const props = defineProps<{ inset?: boolean; class?: string }>()
</script>

<template>
  <DropdownMenuLabel
    :class="cn('px-2 py-1.5 text-sm font-semibold', props.inset && 'pl-8', props.class)"
    v-bind="{ ...props, class: undefined }"
  >
    <slot />
  </DropdownMenuLabel>
</template>
