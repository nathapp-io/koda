<script setup lang="ts">
import { SelectTrigger, SelectIcon } from 'radix-vue'
import { LucideChevronDown } from 'lucide-vue-next'
import { cn } from '~/lib/utils'
</script>

<template>
  <SelectTrigger
    :class="cn(
      'flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      $attrs.class as string
    )"
    v-bind="{ ...$attrs, class: undefined }"
  >
    <slot />
    <SelectIcon as-child>
      <LucideChevronDown class="h-4 w-4 opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>
