<script setup lang="ts">
import { RadioGroupItem, type RadioGroupItemProps } from 'radix-vue'
import { cn } from '~/lib/utils'

const props = defineProps<RadioGroupItemProps & { class?: string }>()
</script>

<template>
  <RadioGroupItem
    :class="cn(
      'aspect-square h-4 w-4 rounded-full border border-primary text-primary ring-offset-background focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
      props.class
    )"
    v-bind="{ ...props, class: undefined }"
  />
</template>
