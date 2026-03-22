<script setup lang="ts">
import { DropdownMenuSeparator } from 'radix-vue'
import { cn } from '~/lib/utils'
</script>

<template>
  <DropdownMenuSeparator :class="cn('-mx-1 my-1 h-px bg-muted', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }" />
</template>
