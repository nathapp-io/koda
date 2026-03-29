<script setup lang="ts">
import { Monitor, Sun, Moon } from 'lucide-vue-next'

const colorMode = useColorMode()

const modes = [
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
] as const

function setMode(mode: string) {
  colorMode.preference = mode
}
</script>

<template>
  <div class="flex items-center gap-0.5 rounded-md border border-border p-0.5">
    <button
      v-for="mode in modes"
      :key="mode.value"
      :title="mode.label"
      :class="[
        'rounded px-1.5 py-0.5 text-xs transition-colors flex items-center',
        colorMode.preference === mode.value
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted',
      ]"
      @click="setMode(mode.value)"
    >
      <component :is="mode.icon" class="h-3.5 w-3.5" />
    </button>
  </div>
</template>
