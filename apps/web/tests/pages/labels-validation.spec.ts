import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = '/Users/subrinaai/Desktop/workspace/subrina-coder/projects/koda/repos/koda/apps/web'
const labelsPagePath = join(webDir, 'pages/[project]/labels.vue')

describe('US-003 AC3: Given normalized value does not match ^#[0-9A-F]{6}$, when submit is attempted, then form shows validation error and blocks request', () => {
  test('labels.vue imports normalizeHexColor from lib/utils', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain("import { normalizeHexColor } from '~/lib/utils'")
  })

  test('labels.vue formSchema color field uses z.string().regex() for hex validation', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toMatch(/color:\s*z\.string\(\)\.regex/)
  })

  test('labels.vue formSchema color field validates against ^#[0-9A-F]{6}$ pattern', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toMatch(/#[0-9A-F]{6}/)
  })

  test('labels.vue onSubmit calls normalizeHexColor before sending to API', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toContain('normalizeHexColor')
    const onSubmitMatch = source.match(/const onSubmit = handleSubmit\(async \(values\) =>\s*\{[\s\S]*?\}\)/)
    expect(onSubmitMatch).not.toBeNull()
    expect(onSubmitMatch![0]).toContain('normalizeHexColor')
  })

  test('labels.vue onSubmit sends normalized color to POST /projects/:slug/labels', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const onSubmitMatch = source.match(/const onSubmit = handleSubmit\(async \(values\) =>\s*\{[\s\S]*?\}\)/)
    expect(onSubmitMatch).not.toBeNull()
    const onSubmitBody = onSubmitMatch![0]
    expect(onSubmitBody).toMatch(/\$api\.post\(`\/projects\/\$\{slug\}\/labels`/)
    expect(onSubmitBody).toContain('color: normalizeHexColor')
  })

  test('labels.vue form shows FormMessage for color field validation error', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const colorFieldMatch = source.match(/FormField\s+name="color"[\s\S]*?<\/FormField>/)
    expect(colorFieldMatch).not.toBeNull()
    expect(colorFieldMatch![0]).toContain('FormMessage')
  })

  test('labels.vue form has handleSubmit to block invalid submissions', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    expect(source).toMatch(/handleSubmit/)
    expect(source).toMatch(/<form[^>]*@submit="onSubmit"/)
  })
})

describe('US-003 AC4: Given valid color input, when submit occurs, then POST /projects/:slug/labels receives normalized color', () => {
  test('labels.vue onSubmit normalizes color before API call', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const onSubmitMatch = source.match(/const onSubmit = handleSubmit\(async \(values\) =>\s*\{[\s\S]*?\}\)/)
    expect(onSubmitMatch).not.toBeNull()
    const onSubmitBody = onSubmitMatch![0]
    const apiCallMatch = onSubmitBody.match(/\$api\.post\([^)]+\)/)
    expect(apiCallMatch).not.toBeNull()
    expect(apiCallMatch![0]).toContain('normalizeHexColor')
  })

  test('labels.vue sends color as part of POST request body', () => {
    const source = readFileSync(labelsPagePath, 'utf-8')
    const onSubmitMatch = source.match(/const onSubmit = handleSubmit\(async \(values\) =>\s*\{[\s\S]*?\}\)/)
    expect(onSubmitMatch).not.toBeNull()
    const onSubmitBody = onSubmitMatch![0]
    expect(onSubmitBody).toMatch(/color:\s*normalizeHexColor/)
  })
})
