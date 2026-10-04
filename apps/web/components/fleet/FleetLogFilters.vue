<script setup lang="ts">
import { computed } from 'vue'
import { EMPTY_LOG_FILTERS, hasActiveFilter, type LogFilters } from '~/lib/fleet-log-query'
import { isLogLevel, LOG_LEVELS, type LogStream } from '~/lib/fleet-log-types'

const props = defineProps<{ stream: LogStream; filters: LogFilters; stories: readonly string[] }>()
const emit = defineEmits<{ update: [filters: LogFilters] }>()
const { t } = useI18n()

const active = computed(() => hasActiveFilter(props.stream, props.filters))
const levelOptions = computed(() => [
  { value: '', label: t('fleet.logs.filters.anyLevel') },
  ...LOG_LEVELS.map((level) => ({ value: level, label: level })),
])

const valueOf = (event: Event): string => ((event.target as HTMLInputElement | HTMLSelectElement | null)?.value ?? '').trim()

/** Text fields apply on change (Enter or blur), not per keystroke: each change resets the cursor and refetches. */
function set(field: 'storyId' | 'stage' | 'role' | 'q', event: Event): void {
  const value = valueOf(event)
  if (value !== props.filters[field]) emit('update', { ...props.filters, [field]: value })
}

function setLevel(value: string): void {
  const level = isLogLevel(value) ? value : null
  if (level !== props.filters.level) emit('update', { ...props.filters, level })
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-3" data-testid="fleet-log-filters">
    <template v-if="stream === 'run'">
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.level') }}</span>
        <FleetNativeSelect :model-value="filters.level ?? ''" :options="levelOptions" testid="fleet-log-filter-level" @update:model-value="setLevel($event)" />
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.story') }}</span>
        <Input :model-value="filters.storyId" list="fleet-log-stories" class="h-9 w-36" data-testid="fleet-log-filter-story" @change="set('storyId', $event)" />
        <datalist id="fleet-log-stories">
          <option v-for="story in stories" :key="story" :value="story" />
        </datalist>
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.stage') }}</span>
        <Input :model-value="filters.stage" class="h-9 w-32" data-testid="fleet-log-filter-stage" @change="set('stage', $event)" />
      </label>
      <label class="space-y-1 text-xs">
        <span class="text-muted-foreground">{{ t('fleet.logs.filters.role') }}</span>
        <Input :model-value="filters.role" class="h-9 w-32" data-testid="fleet-log-filter-role" @change="set('role', $event)" />
      </label>
    </template>
    <label class="space-y-1 text-xs">
      <span class="text-muted-foreground">{{ t('fleet.logs.filters.text') }}</span>
      <Input :model-value="filters.q" class="h-9 w-56" data-testid="fleet-log-filter-text" @change="set('q', $event)" />
    </label>
    <Button v-if="active" variant="ghost" size="sm" data-testid="fleet-log-filter-clear" @click="emit('update', EMPTY_LOG_FILTERS)">
      {{ t('fleet.logs.filters.clear') }}
    </Button>
  </div>
</template>
