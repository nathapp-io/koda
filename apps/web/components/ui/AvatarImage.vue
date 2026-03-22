<template>
  <img
    :src="src"
    :alt="alt"
    :class="cn('aspect-square h-full w-full', $attrs.class)"
    v-bind="{ ...$attrs, class: undefined }"
  />
</template>

<script setup lang="ts">
import { cn } from '~/lib/utils'

defineProps<{
  src: string
  alt?: string
}>()
</script>
