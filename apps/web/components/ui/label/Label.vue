<script setup lang="ts">
import { Label } from 'radix-vue'
import { cn } from '~/lib/utils'
</script>

<template>
  <Label
    :class="cn('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70', $attrs.class as string)"
    v-bind="{ ...$attrs, class: undefined }"
  >
    <slot />
  </Label>
</template>
