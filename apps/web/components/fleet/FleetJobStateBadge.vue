<script setup lang="ts">
import { computed } from 'vue'
import { codeLabel } from '~/lib/fleet-i18n'
import { jobStateDotClass } from '~/lib/fleet-job-state'
import { TICKET_DOT_CLASS } from '~/lib/ticket-chips'

const props = defineProps<{ state: string }>()
const { t, te } = useI18n()

const label = computed(() => codeLabel(t, te, 'fleet.state', props.state))
const dotClass = computed(() => jobStateDotClass(props.state))
</script>

<template>
  <Badge variant="outline" class="gap-1.5 whitespace-nowrap bg-card font-medium" data-testid="fleet-job-state" :data-state="state"><span :class="[TICKET_DOT_CLASS, dotClass]" aria-hidden="true" />{{ label }}</Badge>
</template>
