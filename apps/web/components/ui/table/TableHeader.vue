<script setup lang="ts">
import { cn } from '~/lib/utils'
</script>

<template>
  <thead :class="cn('[&_tr]:border-b', $attrs.class as string)" v-bind="{ ...$attrs, class: undefined }">
    <slot />
  </thead>
</template>
