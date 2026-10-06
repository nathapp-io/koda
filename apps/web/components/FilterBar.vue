<script setup lang="ts">
/**
 * Shared filter-row layout (MASTER-PLAN §6 slice 3): a responsive grid of filter controls.
 * Pages drop their selects (or chips) into the slot. The grid classes stay literal per variant
 * on purpose — an interpolated column count would never reach the Tailwind JIT.
 */
withDefaults(defineProps<{ columns?: '3' | '4' }>(), { columns: '4' })

const COLUMN_CLASS = {
  '3': 'sm:grid-cols-3',
  '4': 'sm:grid-cols-4',
} as const
</script>

<template>
  <div class="grid gap-3" :class="COLUMN_CLASS[columns]" data-testid="filter-bar">
    <slot />
  </div>
</template>
