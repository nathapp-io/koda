<script setup lang="ts">
interface BreadcrumbItem {
  label: string
  to?: string
}

defineProps<{ items: BreadcrumbItem[] }>()
</script>

<template>
  <nav class="flex items-center gap-1.5 text-sm text-muted-foreground">
    <template v-for="(item, i) in items" :key="i">
      <span v-if="i > 0" class="text-muted-foreground/50">/</span>
      <NuxtLink v-if="item.to" :to="item.to" class="hover:text-foreground transition-colors">
        {{ item.label }}
      </NuxtLink>
      <span v-else class="text-foreground font-medium">{{ item.label }}</span>
    </template>
  </nav>
</template>
