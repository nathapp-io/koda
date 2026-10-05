<script setup lang="ts">
/** D393: each tile is one API value, `-` until its panel is ready. */
defineProps<{ tiles: ReadonlyArray<{ id: string; label: string; value: string }> }>()
</script>

<template>
  <dl class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" data-testid="fleet-analytics-tiles">
    <div v-for="tile in tiles" :key="tile.id" class="rounded-md border border-border p-3" :data-testid="`fleet-analytics-tile-${tile.id}`">
      <dt class="text-xs text-muted-foreground">{{ tile.label }}</dt>
      <dd class="mt-1 text-xl font-semibold" :data-testid="`fleet-analytics-tile-${tile.id}-value`">{{ tile.value }}</dd>
    </div>
  </dl>
</template>
