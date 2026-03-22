<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>

<template>
  <tr :class="cn('border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
    <slot />
  </tr>
</template>
