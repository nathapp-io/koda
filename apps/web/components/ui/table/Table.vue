<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>

<template>
  <div class="relative w-full overflow-auto">
    <table :class="cn('w-full caption-bottom text-sm', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
      <slot />
    </table>
  </div>
</template>
