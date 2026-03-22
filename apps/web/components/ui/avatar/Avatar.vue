<template>
  <div
    :class="cn(
      'relative inline-flex h-10 w-10 shrink-0 overflow-hidden rounded-full',
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
