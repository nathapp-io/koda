<template>
  <slot
    :componentField="componentField"
  />
</template>

<script setup lang="ts">
import { provide } from 'vue'
import { useField } from 'vee-validate'

interface Props {
  name: string
}

const props = defineProps<Props>()

const { value, errorMessage, handleChange, handleBlur } = useField(() => props.name)

// Provide error message to FormMessage component
provide('errorMessage', errorMessage)

const componentField = {
  modelValue: value,
  'onUpdate:modelValue': handleChange,
  onBlur: handleBlur,
}
</script>
