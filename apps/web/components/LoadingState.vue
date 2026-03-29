<script setup lang="ts">
import { Loader2 } from 'lucide-vue-next'
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center justify-center py-12 text-muted-foreground">
    <Loader2 class="mr-2 h-4 w-4 animate-spin" />
    {{ t('common.loading') }}
  </div>
</template>
