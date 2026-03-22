<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>

<template>
  <caption :class="cn('mt-4 text-sm text-muted-foreground', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
    <slot />
  </caption>
</template>
