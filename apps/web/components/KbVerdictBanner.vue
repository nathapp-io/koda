<script setup lang="ts">
const props = defineProps<{
  verdict: 'likely_duplicate' | 'possibly_related' | 'no_match' | null
  bestMatch?: string | null
}>()

const { t } = useI18n()

const verdictConfig = computed(() => {
  switch (props.verdict) {
    case 'likely_duplicate':
      return {
        label: t('kb.verdict.likelyDuplicate'),
        description: props.bestMatch
          ? t('kb.verdict.bestMatch', { match: props.bestMatch })
          : t('kb.verdict.likelyDuplicateDesc'),
        dot: 'bg-status-rejected',
      }
    case 'possibly_related':
      return {
        label: t('kb.verdict.possiblyRelated'),
        description: props.bestMatch
          ? t('kb.verdict.closestMatch', { match: props.bestMatch })
          : t('kb.verdict.possiblyRelatedDesc'),
        dot: 'bg-status-review',
      }
    case 'no_match':
      return {
        label: t('kb.verdict.noMatch'),
        description: t('kb.verdict.noMatchDesc'),
        dot: 'bg-muted-foreground',
      }
    default:
      return null
  }
})
</script>

<template>
  <div
    v-if="verdictConfig"
    class="flex items-start gap-3 rounded-lg border border-border bg-card p-4 text-foreground"
  >
    <span class="mt-2 h-2 w-2 flex-shrink-0 rounded-full" :class="verdictConfig.dot" />
    <div>
      <p class="font-medium">{{ verdictConfig.label }}</p>
      <p class="text-sm text-muted-foreground">{{ verdictConfig.description }}</p>
    </div>
  </div>
</template>
