<script setup lang="ts">
import { ref, computed } from 'vue'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { marked } from 'marked'

interface Props {
  modelValue: string
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const activeTab = ref<'write' | 'preview'>('write')

const renderedHtml = computed(() => {
  try {
    return marked(props.modelValue || '')
  } catch {
    return props.modelValue || ''
  }
})

function handleInput(event: Event) {
  const target = event.target as HTMLTextAreaElement
  emit('update:modelValue', target.value)
}
</script>

<template>
  <Tabs v-model="activeTab" class="w-full">
    <TabsList class="w-full justify-start border-b rounded-none bg-muted/50">
      <TabsTrigger value="write">Write</TabsTrigger>
      <TabsTrigger value="preview">Preview</TabsTrigger>
    </TabsList>
    <TabsContent value="write" class="mt-2">
      <Textarea
        :model-value="modelValue"
        class="min-h-[200px] font-mono text-sm"
        @input="handleInput"
      />
    </TabsContent>
    <TabsContent value="preview" class="mt-2">
      <!-- marked renders fenced code blocks as <pre><code> elements -->
      <div
        class="min-h-[200px] p-4 border rounded-md bg-background overflow-auto prose prose-sm dark:prose-invert max-w-none"
        v-html="renderedHtml"
      />
    </TabsContent>
  </Tabs>
</template>
