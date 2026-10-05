<script setup lang="ts">
// Layout-only: a named home for the filter-row grid; no behavior of its own.
</script>

<template>
  <!--
    Shared filter-row layout (MASTER-PLAN §6 slice 3): a responsive grid of filter controls.
    The grid keeps the classes literal on purpose — an interpolated column count would never
    reach the Tailwind JIT. Pages drop their selects (or chips) into the slot.
  -->
  <div class="grid gap-3 sm:grid-cols-4" data-testid="filter-bar">
    <slot />
  </div>
</template>
