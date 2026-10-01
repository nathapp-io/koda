<template>
  <span :title="iso ?? undefined">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ageParts } from '~/lib/fleet-age'

/** "3m ago" (mode ago) or "3m" (mode duration) for an ISO time; an em dash when unknown. */
const props = defineProps<{ iso: string | null; now: Date; mode: 'ago' | 'duration' }>()

const { t } = useI18n()

const text = computed(() => {
  const age = ageParts(props.iso, props.now)
  return age ? t(`fleet.common.${props.mode}.${age.unit}`, { n: age.n }) : '—'
})
</script>
