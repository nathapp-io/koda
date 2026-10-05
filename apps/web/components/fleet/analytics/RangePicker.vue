<script setup lang="ts">
import { ref, watch } from 'vue'
import { RANGE_PRESETS } from '~/lib/fleet-analytics-range'
import type { RangePreset, RangeState } from '~/lib/fleet-analytics-range'

/** D392: presets plus a custom from/to (inclusive). Native date inputs; the page validates the span. */
const props = defineProps<{ modelValue: RangeState; invalid?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: RangeState] }>()
const { t } = useI18n()

const customOpen = ref(props.modelValue.kind === 'custom')
const from = ref(props.modelValue.kind === 'custom' ? props.modelValue.from : '')
const to = ref(props.modelValue.kind === 'custom' ? props.modelValue.to : '')

watch(() => props.modelValue, (value) => {
  if (value.kind !== 'custom') return
  customOpen.value = true
  from.value = value.from
  to.value = value.to
})

const isActive = (days: RangePreset): boolean => props.modelValue.kind === 'preset' && props.modelValue.days === days
const inputValue = (event: Event): string => (event.target as HTMLInputElement | null)?.value ?? ''

function pick(days: RangePreset): void {
  customOpen.value = false
  emit('update:modelValue', { kind: 'preset', days })
}

function onFrom(event: Event): void {
  from.value = inputValue(event)
}

function onTo(event: Event): void {
  to.value = inputValue(event)
}

function apply(): void {
  if (from.value && to.value) emit('update:modelValue', { kind: 'custom', from: from.value, to: to.value })
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2" role="group" :aria-label="t('fleet.analytics.range.label')" data-testid="fleet-analytics-range">
    <Button
      v-for="days in RANGE_PRESETS"
      :key="days"
      size="sm"
      :variant="isActive(days) ? 'default' : 'outline'"
      :aria-pressed="isActive(days)"
      :data-testid="`fleet-analytics-range-${days}`"
      @click="pick(days)"
    >
      {{ t(`fleet.analytics.range.d${days}`) }}
    </Button>
    <Button
      size="sm"
      :variant="modelValue.kind === 'custom' ? 'default' : 'outline'"
      :aria-pressed="modelValue.kind === 'custom'"
      data-testid="fleet-analytics-range-custom"
      @click="customOpen = !customOpen"
    >
      {{ t('fleet.analytics.range.custom') }}
    </Button>
    <template v-if="customOpen">
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.range.from') }}
        <input type="date" :value="from" class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" data-testid="fleet-analytics-range-from" @input="onFrom">
      </label>
      <label class="flex flex-col gap-1 text-xs text-muted-foreground">
        {{ t('fleet.analytics.range.to') }}
        <input type="date" :value="to" class="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground" data-testid="fleet-analytics-range-to" @input="onTo">
      </label>
      <Button size="sm" :disabled="!from || !to" data-testid="fleet-analytics-range-apply" @click="apply()">{{ t('fleet.analytics.range.apply') }}</Button>
    </template>
    <p v-if="invalid" class="w-full text-sm text-destructive" role="alert" data-testid="fleet-analytics-range-invalid">{{ t('fleet.analytics.range.invalid') }}</p>
  </div>
</template>
