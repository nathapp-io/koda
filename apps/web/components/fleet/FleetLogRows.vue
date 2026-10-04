<script setup lang="ts">
import { computed, ref } from 'vue'
import type { FleetJobLogEntryDto } from '~/lib/fleet-log-types'
import { levelVariant, logRowView } from '~/lib/fleet-log-view'

const props = defineProps<{ stream: string; rows: readonly FleetJobLogEntryDto[] }>()
const { t } = useI18n()

/** Offsets of run rows whose `data` is open. */
const expanded = ref<ReadonlySet<number>>(new Set())
const views = computed(() => props.rows.map((row) => logRowView(props.stream, row)))

function toggle(offset: number): void {
  const next = new Set(expanded.value)
  if (next.has(offset)) next.delete(offset)
  else next.add(offset)
  expanded.value = next
}
</script>

<template>
  <ol class="divide-y divide-border font-mono text-xs" data-testid="fleet-log-rows">
    <li v-for="row in views" :key="row.offset" :data-offset="row.offset" data-testid="fleet-log-row">
      <template v-if="row.kind === 'entry'">
        <button
          type="button"
          class="flex w-full flex-wrap items-baseline gap-2 px-2 py-1 text-left hover:bg-muted/50"
          :disabled="row.data === null"
          :aria-expanded="row.data === null ? undefined : expanded.has(row.offset)"
          data-testid="fleet-log-entry"
          @click="toggle(row.offset)"
        >
          <span class="text-muted-foreground" :title="row.timestamp">{{ row.time }}</span>
          <Badge :variant="levelVariant(row.level)" data-testid="fleet-log-level">{{ row.level.toUpperCase() }}</Badge>
          <span v-if="row.stage" class="text-muted-foreground" data-testid="fleet-log-stage">[{{ row.stage }}]</span>
          <span v-if="row.storyId" class="text-muted-foreground" data-testid="fleet-log-story">[{{ row.storyId }}]</span>
          <span v-if="row.role" class="text-muted-foreground" data-testid="fleet-log-role">{{ row.role }}</span>
          <span class="whitespace-pre-wrap break-all" data-testid="fleet-log-message">{{ row.message }}</span>
        </button>
        <pre v-if="row.data !== null && expanded.has(row.offset)" class="overflow-x-auto bg-muted/40 px-2 py-1" data-testid="fleet-log-data">{{ row.data }}</pre>
      </template>
      <div v-else class="flex items-baseline gap-2 px-2 py-1">
        <span v-if="row.unparsed" class="shrink-0 text-muted-foreground" data-testid="fleet-log-unparsed">{{ t('fleet.logs.tags.unparsed') }}</span>
        <span v-if="row.cut" class="shrink-0 text-muted-foreground" data-testid="fleet-log-cut">{{ t('fleet.logs.tags.cut') }}</span>
        <span class="whitespace-pre-wrap break-all" data-testid="fleet-log-text">{{ row.text }}</span>
      </div>
    </li>
  </ol>
</template>
