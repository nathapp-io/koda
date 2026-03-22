<script setup lang="ts">
import { Separator } from 'radix-vue'
import { cn } from '~/lib/utils'

const props = withDefaults(defineProps<{ orientation?: 'horizontal' | 'vertical'; decorative?: boolean; class?: string }>(), {
  orientation: 'horizontal',
  decorative: true,
})
</script>

<template>
  <Separator
    :class="cn(
      'shrink-0 bg-border',
      props.orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
      props.class
    )"
    v-bind="{ ...props, class: undefined }"
  />
</template>
