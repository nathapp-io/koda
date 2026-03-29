<script setup lang="ts">
import { Inbox } from 'lucide-vue-next'
import type { Component } from 'vue'

const props = defineProps<{
  message: string
  icon?: Component
}>()

const iconComponent = computed(() => props.icon ?? Inbox)
</script>

<template>
  <div class="col-span-full flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12">
    <component :is="iconComponent" class="h-10 w-10 text-muted-foreground" />
    <p class="mt-4 text-lg font-medium">{{ message }}</p>
    <slot name="action" />
  </div>
</template>
