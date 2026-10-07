<script setup lang="ts">
import type { TreeGroup } from '~/lib/nax-config'

defineProps<{ groups: TreeGroup[]; selected: string | null }>()
const emit = defineEmits<{ (e: 'select', path: string): void }>()
const { t } = useI18n()

/** Paths are shown without the common `.nax/` prefix; the full path stays in data-path and the title. */
const shortPath = (path: string): string => path.replace(/^\.nax\//, '')
</script>

<template>
  <nav class="space-y-4" data-testid="nax-file-tree" :aria-label="t('fleet.config.tree.label')">
    <div v-for="g in groups" :key="g.group" data-testid="nax-file-group" :data-group="g.group">
      <h3 class="text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t(`fleet.config.group.${g.group}`) }}</h3>
      <ul class="mt-1 space-y-0.5">
        <li v-for="f in g.files" :key="f.path">
          <button
            type="button"
            data-testid="nax-file"
            :data-path="f.path"
            :data-status="f.status"
            :title="f.path"
            :aria-current="selected === f.path ? 'true' : undefined"
            :class="['flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted', selected === f.path ? 'bg-muted font-medium' : '']"
            @click="emit('select', f.path)"
          >
            <span :class="['truncate font-mono text-xs', f.status === 'deleted' ? 'line-through text-muted-foreground' : '']">{{ shortPath(f.path) }}</span>
            <span v-if="f.status !== 'unchanged'" data-testid="nax-file-marker" class="ml-auto shrink-0 text-xs text-primary">{{ t(`fleet.config.status.${f.status}`) }}</span>
          </button>
        </li>
      </ul>
    </div>
  </nav>
</template>
