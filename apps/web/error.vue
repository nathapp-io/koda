<script setup lang="ts">
defineProps<{ error: { statusCode: number; data?: { redirect?: string } | null } }>()
</script>

<template>
  <AppErrorPage :error="error" />
</template>
