<script setup lang="ts">
const props = defineProps<{
  verdict: 'likely_duplicate' | 'possibly_related' | 'no_match' | null
  bestMatch?: string | null
}>()

const verdictConfig = computed(() => {
  switch (props.verdict) {
    case 'likely_duplicate':
      return {
        label: 'Likely Duplicate',
        description: props.bestMatch ? `Best match: ${props.bestMatch}` : 'A very similar issue already exists.',
        classes: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200',
        dot: 'bg-red-500',
      }
    case 'possibly_related':
      return {
        label: 'Possibly Related',
        description: props.bestMatch ? `Closest match: ${props.bestMatch}` : 'Some related issues were found.',
        classes: 'bg-yellow-50 border-yellow-200 text-yellow-800 dark:bg-yellow-950 dark:border-yellow-800 dark:text-yellow-200',
        dot: 'bg-yellow-500',
      }
    case 'no_match':
      return {
        label: 'No Match',
        description: 'No closely related issues found.',
        classes: 'bg-gray-50 border-gray-200 text-gray-700 dark:bg-gray-900 dark:border-gray-700 dark:text-gray-300',
        dot: 'bg-gray-400',
      }
    default:
      return null
  }
})
</script>

<template>
  <div
    v-if="verdictConfig"
    class="flex items-start gap-3 rounded-lg border p-4"
    :class="verdictConfig.classes"
  >
    <span class="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full" :class="verdictConfig.dot" />
    <div>
      <p class="font-semibold">{{ verdictConfig.label }}</p>
      <p class="text-sm opacity-80">{{ verdictConfig.description }}</p>
    </div>
  </div>
</template>
