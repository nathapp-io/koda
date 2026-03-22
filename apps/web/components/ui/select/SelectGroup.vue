<script setup lang="ts">
import { SelectGroup } from 'radix-vue'
</script>

<template>
  <SelectGroup v-bind="$attrs">
    <slot />
  </SelectGroup>
</template>
