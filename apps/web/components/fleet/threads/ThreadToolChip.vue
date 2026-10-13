<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ToolSummaryEntry } from '~/lib/thread-types'
import { toolChipState } from '~/lib/thread-view'

/**
 * Fleet S5a §4.62 (US-006): one folded tool call. Collapsed by default; expanding shows the
 * `input` and `preview`, both plain text (B4-D1) — never `v-html`. The chip's state comes from
 * the pure `toolChipState` (profile-denied, running while streaming, unfinished when never
 * resolved, else ok/error).
 */
const props = defineProps<{ entry: ToolSummaryEntry; messageStatus: string }>()
const { t } = useI18n()

const state = computed(() => toolChipState(props.entry, props.messageStatus))
const expanded = ref(false)
</script>

<template>
  <div class="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs" data-testid="thread-tool-chip">
    <button
      type="button"
      class="inline-flex items-center gap-1.5 font-mono hover:text-foreground"
      :aria-expanded="expanded ? 'true' : 'false'"
      @click="expanded = !expanded"
    >
      <span class="text-muted-foreground">{{ props.entry.name }}</span>
      <span class="rounded bg-muted px-1 text-xs text-muted-foreground">{{ t(`fleet.threads.tool.${state}`) }}</span>
    </button>
    <div v-if="expanded" class="mt-1 space-y-1 font-mono">
      <div v-if="props.entry.input" class="whitespace-pre-wrap break-words">{{ props.entry.input }}</div>
      <div v-if="props.entry.preview" class="whitespace-pre-wrap break-words">{{ props.entry.preview }}</div>
    </div>
  </div>
</template>