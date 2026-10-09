<script setup lang="ts">
const props = defineProps<{ projectSlug: string }>()
</script>

<template>
  <div data-testid="assignee-picker-stub">{{ props.projectSlug }}</div>
</template>
