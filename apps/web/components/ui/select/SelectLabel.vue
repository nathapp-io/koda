<script setup lang="ts">
import { SelectLabel } from 'radix-vue'
import { cn } from '~/lib/utils'
</script>

<template>
  <SelectLabel :class="cn('py-1.5 pl-8 pr-2 text-sm font-semibold', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
    <slot />
  </SelectLabel>
</template>
