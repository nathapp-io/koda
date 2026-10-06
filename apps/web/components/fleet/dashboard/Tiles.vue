<script setup lang="ts">
import type { DashboardTile } from '~/lib/fleet-dashboard'

/** D423: the four counts; each tile links to its section. */
defineProps<{ tiles: readonly DashboardTile[] }>()
const { t } = useI18n()
</script>

<template>
  <ul class="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="fleet-dashboard-tiles">
    <li v-for="tile in tiles" :key="tile.id">
      <a
        :href="tile.href"
        class="block rounded-md border border-border p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :data-testid="`fleet-dashboard-tile-${tile.id}`"
        :data-tone="tile.tone"
      >
        <span class="block text-xs text-muted-foreground">{{ t(`fleet.dashboard.tiles.${tile.id}`) }}</span>
        <span
          class="mt-1 block text-xl font-semibold"
          :class="{ 'text-status-review': tile.tone === 'warn', 'text-status-rejected': tile.tone === 'bad' }"
          :data-testid="`fleet-dashboard-tile-${tile.id}-value`"
        >{{ tile.value }}</span>
      </a>
    </li>
  </ul>
</template>
