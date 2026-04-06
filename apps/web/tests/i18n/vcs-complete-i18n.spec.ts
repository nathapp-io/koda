import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const enLocalesPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalesPath = join(webDir, 'i18n', 'locales', 'zh.json')

/**
 * VCS-P1-005-F: Comprehensive i18n test for all VCS feature strings
 * This test verifies that all VCS-related translation keys exist in both en.json and zh.json
 * and that they have non-empty values
 */

describe('VCS-P1-005-F: Web i18n - VCS Integration Form Keys', () => {
  const formKeys = [
    'vcs.form.provider',
    'vcs.form.providerPlaceholder',
    'vcs.form.owner',
    'vcs.form.ownerPlaceholder',
    'vcs.form.repo',
    'vcs.form.repoPlaceholder',
    'vcs.form.token',
    'vcs.form.tokenPlaceholder',
    'vcs.form.syncMode',
    'vcs.form.syncModePolling',
    'vcs.form.syncModeWebhook',
    'vcs.form.pollingInterval',
    'vcs.form.pollingIntervalPlaceholder',
    'vcs.form.authors',
    'vcs.form.authorsPlaceholder',
    'vcs.form.submit',
    'vcs.form.update',
    'vcs.form.testing',
    'vcs.form.testConnection',
    'vcs.form.syncing',
    'vcs.form.syncNow',
    'vcs.form.disconnect',
  ]

  formKeys.forEach((key) => {
    test(`en.json contains ${key}`, () => {
      const content = readFileSync(enLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })

    test(`zh.json contains ${key}`, () => {
      const content = readFileSync(zhLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: Web i18n - VCS Form Validation Keys', () => {
  const validationKeys = [
    'vcs.validation.providerRequired',
    'vcs.validation.ownerRequired',
    'vcs.validation.repoRequired',
    'vcs.validation.tokenRequired',
    'vcs.validation.pollingIntervalMin',
    'vcs.validation.pollingIntervalMax',
  ]

  validationKeys.forEach((key) => {
    test(`en.json contains ${key}`, () => {
      const content = readFileSync(enLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })

    test(`zh.json contains ${key}`, () => {
      const content = readFileSync(zhLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: Web i18n - VCS Toast Messages', () => {
  const toastKeys = [
    'vcs.toast.connectionSuccess',
    'vcs.toast.connectionTestSuccess',
    'vcs.toast.connectionTestFailed',
    'vcs.toast.syncComplete',
    'vcs.toast.syncFailed',
  ]

  toastKeys.forEach((key) => {
    test(`en.json contains ${key}`, () => {
      const content = readFileSync(enLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })

    test(`zh.json contains ${key}`, () => {
      const content = readFileSync(zhLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: Web i18n - VCS Ticket Card Badge', () => {
  const badgeKeys = ['tickets.vcs.github']

  badgeKeys.forEach((key) => {
    test(`en.json contains ${key}`, () => {
      const content = readFileSync(enLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })

    test(`zh.json contains ${key}`, () => {
      const content = readFileSync(zhLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: Web i18n - VCS Import Issue Dialog Keys', () => {
  const importIssueKeys = [
    'vcs.importIssue.title',
    'vcs.importIssue.label',
    'vcs.importIssue.placeholder',
    'vcs.importIssue.submit',
    'vcs.importIssue.success',
    'vcs.importIssue.validation.invalidNumber',
  ]

  importIssueKeys.forEach((key) => {
    test(`en.json contains ${key}`, () => {
      const content = readFileSync(enLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })

    test(`zh.json contains ${key}`, () => {
      const content = readFileSync(zhLocalesPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: unknown = json
      keys.forEach((k) => {
        value = (value as Record<string, unknown>)?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect((value as string).length).toBeGreaterThan(0)
    })
  })
})
