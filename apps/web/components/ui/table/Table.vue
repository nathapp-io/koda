<script setup lang="ts">
import { cn } from '~/lib/utils'

defineProps<{ regionLabel?: string }>()
</script>

<template>
  <div
    class="relative w-full overflow-auto"
    :role="regionLabel ? 'region' : undefined"
    :aria-label="regionLabel"
    :tabindex="regionLabel ? 0 : undefined"
  >
    <table :class="cn('w-full caption-bottom text-sm', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
      <slot />
    </table>
  </div>
</template>
