<script setup lang="ts">
import { ref, watch } from 'vue'
import { marked } from 'marked'

interface Props {
  modelValue: string
  placeholder?: string
  minHeight?: string
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: '',
  minHeight: '120px',
})

const { t } = useI18n()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const activeTab = ref<'write' | 'preview'>('write')
const localValue = ref(props.modelValue)
const previewHtml = ref('')
const renderError = ref(false)

// Configure marked for GFM with breaks
marked.setOptions({
  breaks: true,
  gfm: true,
})

function renderMarkdown(source: string) {
  renderError.value = false
  try {
    previewHtml.value = marked.parse(source) as string
  } catch {
    renderError.value = true
    previewHtml.value = `<pre class="whitespace-pre-wrap">${source}</pre>`
  }
}

watch(
  () => props.modelValue,
  (newVal) => {
    localValue.value = newVal
    if (activeTab.value === 'preview') {
      renderMarkdown(newVal)
    }
  }
)

watch(localValue, (newVal) => {
  emit('update:modelValue', newVal)
})

function switchToPreview() {
  activeTab.value = 'preview'
  renderMarkdown(localValue.value)
}

function switchToWrite() {
  activeTab.value = 'write'
}
</script>

<template>
  <div class="border rounded-md">
    <!-- Tab Headers -->
    <div class="flex border-b">
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="
          activeTab === 'write'
            ? 'border-b-2 border-primary text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="switchToWrite"
      >
        {{ t('markdown.write') }}
      </button>
      <button
        type="button"
        class="px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="
          activeTab === 'preview'
            ? 'border-b-2 border-primary text-foreground'
            : 'text-muted-foreground hover:text-foreground'
        "
        @click="switchToPreview"
      >
        {{ t('markdown.preview') }}
      </button>
    </div>

    <!-- Write Tab -->
    <div v-show="activeTab === 'write'" class="p-0">
      <textarea
        v-model="localValue"
        :placeholder="placeholder"
        :style="{ minHeight }"
        class="flex w-full p-3 text-sm bg-transparent border-0 resize-y focus:outline-none focus:ring-0 font-mono placeholder:text-muted-foreground"
      />
    </div>

    <!-- Preview Tab -->
    <div
      v-show="activeTab === 'preview'"
      class="p-4 text-sm prose prose-sm max-w-none"
      :style="{ minHeight }"
    >
      <p v-if="renderError" class="text-destructive text-xs mb-2">
        {{ t('markdown.renderError') }}
      </p>
      <div
        v-if="previewHtml"
        v-html="previewHtml"
        class="whitespace-pre-wrap"
      />
      <p v-else class="text-muted-foreground italic">
        {{ t('markdown.emptyPreview') }}
      </p>
    </div>
  </div>
</template>
