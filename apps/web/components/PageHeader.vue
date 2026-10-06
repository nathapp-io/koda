<script setup lang="ts">
defineProps<{
  title: string
  subtitle?: string
}>()
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 items-center gap-3">
      <div
        v-if="$slots.icon"
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground"
      >
        <slot name="icon" />
      </div>
      <div class="min-w-0">
        <h1 class="text-3xl font-bold tracking-tight">{{ title }}</h1>
        <p v-if="subtitle" class="mt-2 text-muted-foreground">{{ subtitle }}</p>
      </div>
    </div>
    <div class="flex flex-wrap items-center justify-end gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
