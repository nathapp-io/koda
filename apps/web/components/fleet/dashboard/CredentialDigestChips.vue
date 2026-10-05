<script setup lang="ts">
import { computed } from 'vue'
import type { ChipTone } from '~/lib/fleet-capabilities'
import { digestChips, renderText } from '~/lib/fleet-dashboard'
import type { DashboardCredential } from '~/lib/fleet-dashboard-types'

/** D424: admin-only credential chips from the dashboard digest (raw capabilities never reach this page). */
const props = defineProps<{ credentials: readonly DashboardCredential[] }>()
const { t, te } = useI18n()

const chips = computed(() =>
  digestChips(props.credentials).map((chip) => ({
    id: chip.id,
    tone: chip.tone,
    text: renderText(chip.text, (key, named) => t(key, named ?? {}), te),
  })))

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}
</script>

<template>
  <div v-if="chips.length > 0" class="flex flex-wrap gap-1" data-testid="fleet-dashboard-credentials">
    <Badge v-for="chip in chips" :key="chip.id" :variant="variantOf(chip.tone)" data-testid="fleet-dashboard-credential" :data-tone="chip.tone">
      {{ chip.text }}
    </Badge>
  </div>
</template>
