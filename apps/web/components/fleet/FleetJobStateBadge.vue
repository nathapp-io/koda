<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'

const props = defineProps<{ state: string }>()
const { t, te } = useI18n()

type Variant = 'default' | 'secondary' | 'destructive' | 'outline'
const VARIANTS: Readonly<Record<string, Variant>> = {
  COMPLETED: 'default',
  FAILED: 'destructive',
  CRASHED: 'destructive',
  ESCALATED: 'outline',
  CANCELLED: 'outline',
}

const variant = computed<Variant>(() => VARIANTS[props.state] ?? 'secondary')
const label = computed(() => codeLabel(t, te, 'fleet.state', props.state))
</script>

<template>
  <Badge :variant="variant" data-testid="fleet-job-state" :data-state="state">{{ label }}</Badge>
</template>
