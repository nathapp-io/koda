<template>
  <p v-if="errorMessage" :class="cn('text-sm font-medium text-destructive', $attrs.class)">
    {{ errorMessage }}
  </p>
</template>

<script setup lang="ts">
import { computed, inject } from 'vue'
import { cn } from '~/lib/utils'

interface Props {
  name?: string
}

const props = defineProps<Props>()

// Get error message from parent FormField via provide/inject or use empty string
const errorMessage = inject<string>('errorMessage', '')
</script>
