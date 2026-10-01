<template>
  <select
    :id="id"
    :value="modelValue"
    :data-testid="testid"
    class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
    @change="onChange"
    @blur="emit('blur', $event)"
  >
    <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
    <option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option>
  </select>
</template>

<script setup lang="ts">
/**
 * A native <select> that speaks the v-model protocol, so vee-validate's `componentField`
 * (modelValue + onUpdate:modelValue + onBlur) binds to it. Binding componentField straight onto a
 * bare <select> renders `modelvalue` as an attribute and never updates the form (plan D137).
 *
 * `id` is the field name its <FormLabel> points at, so the control has an accessible name.
 */
interface NativeSelectOption {
  value: string
  label: string
}

defineProps<{ modelValue?: string; options: readonly NativeSelectOption[]; testid?: string; placeholder?: string; id?: string }>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'blur', event: FocusEvent): void
}>()

function onChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  emit('update:modelValue', target?.value ?? '')
}
</script>
