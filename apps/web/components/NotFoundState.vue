<script setup lang="ts">
defineProps<{ title: string; body?: string; backTo: string; backLabel: string }>()
</script>

<template>
  <div data-testid="not-found-state" class="text-center py-12">
    <h1 data-testid="not-found-title">{{ title }}</h1>
    <p v-if="body" data-testid="not-found-body" class="text-muted-foreground">{{ body }}</p>
    <NuxtLink data-testid="not-found-back" :to="backTo">{{ backLabel }}</NuxtLink>
  </div>
</template>
