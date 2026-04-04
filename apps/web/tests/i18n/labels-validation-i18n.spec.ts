import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = '/Users/subrinaai/Desktop/workspace/subrina-coder/projects/koda/repos/koda/apps/web'
const enPath = join(webDir, 'i18n/locales/en.json')
const zhPath = join(webDir, 'i18n/locales/zh.json')

describe('US-003: labels.validation.colorInvalid i18n key exists in en.json', () => {
  test('en.json contains labels.validation.colorInvalid key', () => {
    const source = readFileSync(enPath, 'utf-8')
    const i18n = JSON.parse(source)
    expect(i18n.labels.validation).toBeDefined()
    expect(i18n.labels.validation.colorInvalid).toBeDefined()
    expect(typeof i18n.labels.validation.colorInvalid).toBe('string')
    expect(i18n.labels.validation.colorInvalid.length).toBeGreaterThan(0)
  })

  test('en.json labels.validation.colorInvalid is a meaningful error message', () => {
    const source = readFileSync(enPath, 'utf-8')
    const i18n = JSON.parse(source)
    const msg = i18n.labels.validation.colorInvalid.toLowerCase()
    expect(msg).toMatch(/color|hex/)
  })
})

describe('US-003: labels.validation.colorInvalid i18n key exists in zh.json', () => {
  test('zh.json contains labels.validation.colorInvalid key', () => {
    const source = readFileSync(zhPath, 'utf-8')
    const i18n = JSON.parse(source)
    expect(i18n.labels.validation).toBeDefined()
    expect(i18n.labels.validation.colorInvalid).toBeDefined()
    expect(typeof i18n.labels.validation.colorInvalid).toBe('string')
    expect(i18n.labels.validation.colorInvalid.length).toBeGreaterThan(0)
  })

  test('zh.json labels.validation.colorInvalid has same structure as en', () => {
    const enSource = readFileSync(enPath, 'utf-8')
    const zhSource = readFileSync(zhPath, 'utf-8')
    const enI18n = JSON.parse(enSource)
    const zhI18n = JSON.parse(zhSource)
    expect(Object.keys(enI18n.labels.validation)).toEqual(Object.keys(zhI18n.labels.validation))
  })
})

describe('US-003: labels.vue uses i18n key for color validation error message', () => {
  test('labels.vue formSchema color field uses t() for error message', () => {
    const labelsPagePath = join(webDir, 'pages/[project]/labels.vue')
    const source = readFileSync(labelsPagePath, 'utf-8')
    const colorSchemaMatch = source.match(/color:\s*z\.string\(\)[^,]*,[^)]*\.regex\([^)]+\)/)
    expect(colorSchemaMatch).not.toBeNull()
    expect(colorSchemaMatch![0]).toMatch(/t\(['"]labels\.validation\.colorInvalid['"]\)/)
  })
})
