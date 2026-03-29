<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'

defineProps<{ to: string }>()
</script>

<template>
  <NuxtLink :to="to">
    <Button variant="ghost" size="icon">
      <ArrowLeft class="h-4 w-4" />
    </Button>
  </NuxtLink>
</template>
