<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next'

defineProps<{ to: string }>()

const { t } = useI18n()
</script>

<template>
  <!-- Icon-only back navigation: the accessible name comes from aria-label
       (axe button-name/link-name); there is no visible text by design. -->
  <NuxtLink :to="to" :aria-label="t('common.back')">
    <Button variant="ghost" size="icon" :aria-label="t('common.back')">
      <ArrowLeft class="h-4 w-4" aria-hidden="true" />
    </Button>
  </NuxtLink>
</template>
