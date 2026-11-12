<template>
  <div
    :class="cn(
      'flex h-full w-full items-center justify-center rounded-full bg-muted text-muted-foreground',
      $attrs.class
    )"
    v-bind="{ ...$attrs, class: undefined }"
  >
    <slot />
  </div>
</template>

<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>
