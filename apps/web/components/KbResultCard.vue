<script setup lang="ts">
defineProps<{
  id: string
  source: string
  sourceId: string
  content: string
  score: number
  similarity: 'high' | 'medium' | 'low'
  createdAt: string
}>()

const similarityConfig = {
  high: { label: 'HIGH', classes: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300' },
  medium: { label: 'MED', classes: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
  low: { label: 'LOW', classes: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}
</script>

<template>
  <div class="flex items-start gap-4 rounded-lg border border-border bg-card p-4">
    <!-- Score pill -->
    <span
      class="mt-0.5 flex-shrink-0 rounded px-2 py-0.5 text-xs font-bold"
      :class="similarityConfig[similarity].classes"
    >
      {{ similarityConfig[similarity].label }} {{ score.toFixed(2) }}
    </span>

    <div class="min-w-0 flex-1">
      <!-- Source ID -->
      <p class="text-sm font-semibold text-foreground">{{ sourceId }}</p>
      <!-- Content snippet -->
      <p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{{ content }}</p>
      <!-- Meta -->
      <div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span class="rounded border border-border px-1.5 py-0.5">{{ source }}</span>
        <span>{{ new Date(createdAt).toLocaleDateString() }}</span>
      </div>
    </div>
  </div>
</template>
