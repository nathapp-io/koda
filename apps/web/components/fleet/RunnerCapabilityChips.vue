<template>
  <div class="flex flex-wrap gap-1">
    <Badge v-for="chip in chips" :key="chip.id" :variant="variantOf(chip.tone)">
      {{ t(chip.key, paramsOf(chip)) }}
    </Badge>
    <span v-if="version" class="text-xs text-muted-foreground">nax {{ version }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { capabilityChips, naxVersion } from '~/lib/fleet-capabilities'
import type { CapabilityChip, ChipTone } from '~/lib/fleet-capabilities'

const props = defineProps<{ capabilities: Record<string, unknown> }>()

const { t, te } = useI18n()

const chips = computed(() => capabilityChips(props.capabilities))
const version = computed(() => naxVersion(props.capabilities))

function variantOf(tone: ChipTone): 'secondary' | 'outline' | 'destructive' {
  if (tone === 'bad') return 'destructive'
  return tone === 'warn' ? 'outline' : 'secondary'
}

/** A credential chip carries its kind as a code: show its label (an unknown code shows raw, plan D126). */
function paramsOf(chip: CapabilityChip): Record<string, string> {
  const kind = chip.params.kind
  if (!kind) return chip.params
  const key = `fleet.runners.chip.kind.${kind}`
  return { ...chip.params, kind: te(key) ? t(key) : kind }
}
</script>
