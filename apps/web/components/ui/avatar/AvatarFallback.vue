<template>
  <div
    :class="cn(
      'flex items-center justify-center bg-muted text-muted-foreground',
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
