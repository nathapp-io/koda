<script setup lang="ts">
import { TabsRoot } from 'radix-vue'
import { cn } from '~/lib/utils'

const props = defineProps<{
  defaultValue?: string
  class?: string
}>()
</script>

<template>
  <TabsRoot :default-value="defaultValue" :class="cn('space-y-4', props.class)">
    <slot />
  </TabsRoot>
</template>
