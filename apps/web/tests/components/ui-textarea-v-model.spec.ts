import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * ui/textarea must support v-model like ui/input: TicketActionPanel (transition
 * comments), KbAddDocumentDialog, project settings and MarkdownEditor all bind it.
 * Without the prop + emit the typed text never reached the form, so comment-
 * requiring transitions posted {} and got 400.
 */
const source = readFileSync(join(__dirname, '../../components/ui/textarea/Textarea.vue'), 'utf-8')

describe('ui/textarea v-model contract', () => {
  test('declares a modelValue prop', () => {
    expect(source).toMatch(/defineProps<\{[\s\S]*modelValue\?: string/)
  })

  test('binds the native value to modelValue', () => {
    expect(source).toMatch(/:value="modelValue"/)
  })

  test("emits update:modelValue with the textarea's value on input", () => {
    expect(source).toMatch(/'update:modelValue': \[value: string\]/)
    expect(source).toMatch(/@input="\$emit\('update:modelValue', \(\$event\.target as HTMLTextAreaElement\)\.value\)"/)
  })

  test('does not leak modelValue / onUpdate:modelValue as raw attributes', () => {
    expect(source).toMatch(/defineOptions\(\{ inheritAttrs: false \}\)/)
    expect(source).toMatch(/modelValue: _mv, 'onUpdate:modelValue': _up/)
    expect(source).not.toMatch(/v-bind="\{ \.\.\.\$attrs/)
  })
})
