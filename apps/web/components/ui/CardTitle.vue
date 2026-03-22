<template>
  <h2 :class="cn('text-2xl font-semibold leading-none tracking-tight', $attrs.class)">
    <slot />
  </h2>
</template>

<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>
