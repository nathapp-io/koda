<script setup lang="ts">
import { useLocalDates } from '~/lib/local-dates'

const i18n = useI18n()
const { t } = i18n
const dates = useLocalDates(i18n)

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
  high: { label: 'kb.similarity.high', classes: 'bg-status-rejected/10 text-foreground' },
  medium: { label: 'kb.similarity.medium', classes: 'bg-status-review/10 text-foreground' },
  low: { label: 'kb.similarity.low', classes: 'bg-muted text-muted-foreground' },
}
</script>

<template>
  <div class="flex items-start gap-4 rounded-lg border border-border bg-card p-4">
    <!-- Score pill -->
    <span
      class="mt-0.5 flex-shrink-0 rounded px-2 py-0.5 text-xs font-medium tabular-nums"
      :class="similarityConfig[similarity].classes"
    >
      {{ t(similarityConfig[similarity].label) }} {{ score.toFixed(2) }}
    </span>

    <div class="min-w-0 flex-1">
      <!-- Source ID -->
      <p class="text-sm font-medium text-foreground">{{ sourceId }}</p>
      <!-- Content snippet -->
      <p class="mt-1 line-clamp-2 text-sm text-muted-foreground">{{ content }}</p>
      <!-- Meta -->
      <div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <span class="rounded border border-border px-1.5 py-0.5">{{ source }}</span>
        <span>{{ dates.date(createdAt) }}</span>
      </div>
    </div>
  </div>
</template>
