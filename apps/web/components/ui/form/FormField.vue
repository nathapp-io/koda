<template>
  <slot :componentField="componentField" />
</template>

<script setup lang="ts">
import { computed, provide } from 'vue'
import { useField } from 'vee-validate'

interface Props {
  name: string
}

const props = defineProps<Props>()

const { value, errorMessage, handleChange, handleBlur } = useField<string>(() => props.name)

provide('errorMessage', errorMessage)

const componentField = computed(() => ({
  modelValue: value.value,
  'onUpdate:modelValue': handleChange,
  onBlur: handleBlur,
}))
</script>
