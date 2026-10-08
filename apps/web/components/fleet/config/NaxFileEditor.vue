<script setup lang="ts">
import { computed } from 'vue'
import MarkdownEditor from '~/components/MarkdownEditor.vue'
import { jsonError } from '~/lib/nax-config'

const props = defineProps<{ path: string; modelValue: string; readonly: boolean; tooLarge: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
const { t } = useI18n()

const isJson = computed(() => props.path.endsWith('.json'))
// Not read directly in the template: Nuxt's auto-import globals `readonly` / `isReadonly`
// (Vue's reactivity API) shadow the prop there and vue-tsc fails TS2774 on `v-else-if="readonly"`.
const viewOnly = computed(() => props.readonly)
const error = computed(() => (isJson.value && !props.readonly ? jsonError(props.modelValue) : null))

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<template>
  <div class="space-y-2" data-testid="nax-editor">
    <p v-if="tooLarge" class="text-sm text-muted-foreground" data-testid="nax-editor-too-large">{{ t('fleet.config.editor.tooLarge') }}</p>
    <pre v-else-if="viewOnly" class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs" data-testid="nax-editor-readonly">{{ modelValue }}</pre>
    <template v-else-if="isJson">
      <textarea
        :value="modelValue"
        :aria-label="path"
        spellcheck="false"
        class="min-h-[320px] w-full rounded-md border border-input bg-background p-3 font-mono text-xs"
        data-testid="nax-editor-json"
        @input="onInput"
      />
      <p v-if="error" class="text-sm text-status-rejected" role="alert" data-testid="nax-editor-json-error">{{ t('fleet.config.editor.jsonError', { error }) }}</p>
    </template>
    <MarkdownEditor v-else :model-value="modelValue" :aria-label="path" @update:model-value="emit('update:modelValue', $event)" />
  </div>
</template>
