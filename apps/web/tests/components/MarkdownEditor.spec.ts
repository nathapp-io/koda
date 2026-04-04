import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const componentPath = join(webDir, 'components', 'MarkdownEditor.vue')

// ──────────────────────────────────────────────────────────────────────────────
// File existence
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: components/MarkdownEditor.vue exists', () => {
  test('file is present at components/MarkdownEditor.vue', () => {
    expect(existsSync(componentPath)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — When markdown editor renders in write mode, editable markdown source
//        is bound to modelValue
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: editable markdown source is bound to modelValue', () => {
  test('source defines modelValue as a prop', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('modelValue')
  })

  test('source uses defineProps with typed props', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTypedProps =
      source.includes('defineProps<') ||
      source.includes('defineProps({')
    expect(hasTypedProps).toBe(true)
  })

  test('source uses v-model to bind the Textarea to modelValue', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasVModel =
      source.includes('v-model') &&
      source.includes('modelValue')
    expect(hasVModel).toBe(true)
  })

  test('source uses a Textarea component for markdown input', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('Textarea')
  })

  test('source uses Tabs with a "write" or "edit" tab value', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTabsWithWrite =
      source.includes('Tabs') &&
      (source.includes('value="write"') ||
       source.includes("value='write'") ||
       source.includes('value="edit"') ||
       source.includes("value='edit'"))
    expect(hasTabsWithWrite).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — When user switches editor to preview mode, rendered output reflects
//        current markdown source
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC2: preview mode renders current markdown source', () => {
  test('source uses Tabs with a "preview" tab value', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasPreviewTab =
      source.includes('Tabs') &&
      (source.includes('value="preview"') ||
       source.includes("value='preview'"))
    expect(hasPreviewTab).toBe(true)
  })

  test('source uses TabsTrigger for switching between write and preview', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('TabsTrigger')
  })

  test('source uses TabsContent for the preview panel', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('TabsContent')
  })

  test('source includes markdown rendering logic or library', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasMarkdownRendering =
      source.includes('marked') ||
      source.includes('markdown') ||
      source.includes('renderMarkdown') ||
      source.includes('parseMarkdown') ||
      source.includes('useMarkdown')
    expect(hasMarkdownRendering).toBe(true)
  })

  test('source renders the markdown content in preview mode', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasPreviewRendering =
      source.includes('v-html') ||
      source.includes('innerHTML')
    expect(hasPreviewRendering).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Given markdown preview renderer throws, when preview requested,
//        component shows plain-text fallback instead of breaking UI
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: markdown renderer error shows plain-text fallback', () => {
  test('source wraps markdown rendering in try-catch', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTryCatch =
      source.includes('try') &&
      (source.includes('catch') || source.includes('} catch'))
    expect(hasTryCatch).toBe(true)
  })

  test('source falls back to v-html or innerHTML with raw text on error', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasFallback =
      (source.includes('catch') && source.includes('v-html')) ||
      (source.includes('catch') && source.includes('innerHTML'))
    expect(hasFallback).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Given parent uses v-model, when editor content changes, component
//        emits updated modelValue
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC4: editor emits updated modelValue on content change', () => {
  test('source uses defineEmits to declare update:modelValue event', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('defineEmits')
  })

  test('source emits update:modelValue event', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasUpdateEmit =
      source.includes('update:modelValue') ||
      source.includes("'update:modelValue'") ||
      source.includes('"update:modelValue"')
    expect(hasUpdateEmit).toBe(true)
  })

  test('source uses @input or v-model on Textarea to trigger updates', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasInputHandler =
      source.includes('@input') ||
      source.includes('v-model:modelValue') ||
      (source.includes('v-model') && source.includes('modelValue'))
    expect(hasInputHandler).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Additional: Preserves line breaks and fenced code blocks
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: markdown rendering preserves line breaks and fenced code blocks', () => {
  test('source uses a markdown library that supports fenced code blocks', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasFencedCodeSupport =
      source.includes('marked') ||
      source.includes('markdown-it') ||
      source.includes('markdown') ||
      source.includes('highlight')
    expect(hasFencedCodeSupport).toBe(true)
  })

  test('source uses pre or code elements for rendered output', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasCodeElements =
      source.includes('<pre') ||
      source.includes('<code') ||
      source.includes('pre>') ||
      source.includes('code>')
    expect(hasCodeElements).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: MarkdownEditor.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — uses existing shadcn Tabs component
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: MarkdownEditor.vue uses existing shadcn Tabs components', () => {
  test('source imports Tabs from ~/components/ui/tabs', () => {
    const source = readFileSync(componentPath, 'utf-8')
    const hasTabsImport =
      source.includes('~/components/ui/tabs') ||
      source.includes('@/components/ui/tabs') ||
      source.includes("components/ui/tabs")
    expect(hasTabsImport).toBe(true)
  })

  test('source uses Tabs, TabsList, TabsTrigger, and TabsContent', () => {
    const source = readFileSync(componentPath, 'utf-8')
    expect(source).toContain('Tabs')
    expect(source).toContain('TabsList')
    expect(source).toContain('TabsTrigger')
    expect(source).toContain('TabsContent')
  })
})
