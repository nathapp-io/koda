<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>

<template>
  <td :class="cn('p-4 align-middle [&:has([role=checkbox])]:pr-0', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
    <slot />
  </td>
</template>
