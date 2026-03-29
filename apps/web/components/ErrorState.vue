<script setup lang="ts">
import { AlertCircle } from 'lucide-vue-next'
const { t } = useI18n()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="text-center py-12">
    <AlertCircle class="mx-auto h-8 w-8 text-destructive" />
    <p class="mt-2 text-sm text-destructive">{{ t('common.loadFailed') }}</p>
    <Button variant="outline" class="mt-4" @click="emit('retry')">
      {{ t('common.retry') }}
    </Button>
  </div>
</template>
