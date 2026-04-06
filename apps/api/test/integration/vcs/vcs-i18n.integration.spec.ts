import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * VCS-P1-005-F: Test that API VCS i18n files exist and contain all required keys
 * This ensures that all VCS-related API messages have proper i18n support
 */

describe('VCS-P1-005-F: API i18n - VCS Translation Files Exist', () => {
  test('apps/api/src/i18n/en/vcs.json exists', () => {
    const vcsEnPath = join(__dirname, '../../../src/i18n/en/vcs.json')
    expect(() => readFileSync(vcsEnPath, 'utf-8')).not.toThrow()
  })

  test('apps/api/src/i18n/zh/vcs.json exists', () => {
    const vcsZhPath = join(__dirname, '../../../src/i18n/zh/vcs.json')
    expect(() => readFileSync(vcsZhPath, 'utf-8')).not.toThrow()
  })
})

describe('VCS-P1-005-F: API i18n - VCS Connection Messages', () => {
  const enPath = join(__dirname, '../../../src/i18n/en/vcs.json')
  const zhPath = join(__dirname, '../../../src/i18n/zh/vcs.json')

  const connectionKeys = [
    'connection.created',
    'connection.updated',
    'connection.deleted',
    'connection.notFound',
    'connection.alreadyExists',
  ]

  connectionKeys.forEach((key) => {
    test(`en/vcs.json contains ${key}`, () => {
      const content = readFileSync(enPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    test(`zh/vcs.json contains ${key}`, () => {
      const content = readFileSync(zhPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: API i18n - VCS Sync Messages', () => {
  const enPath = join(__dirname, '../../../src/i18n/en/vcs.json')
  const zhPath = join(__dirname, '../../../src/i18n/zh/vcs.json')

  const syncKeys = [
    'sync.started',
    'sync.completed',
    'sync.failed',
    'sync.issueAlreadySynced',
    'sync.issueNotFound',
  ]

  syncKeys.forEach((key) => {
    test(`en/vcs.json contains ${key}`, () => {
      const content = readFileSync(enPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    test(`zh/vcs.json contains ${key}`, () => {
      const content = readFileSync(zhPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: API i18n - VCS Test Connection Messages', () => {
  const enPath = join(__dirname, '../../../src/i18n/en/vcs.json')
  const zhPath = join(__dirname, '../../../src/i18n/zh/vcs.json')

  const testKeys = ['test.success', 'test.failed', 'test.connectionError']

  testKeys.forEach((key) => {
    test(`en/vcs.json contains ${key}`, () => {
      const content = readFileSync(enPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    test(`zh/vcs.json contains ${key}`, () => {
      const content = readFileSync(zhPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })
  })
})

describe('VCS-P1-005-F: API i18n - VCS Error Messages', () => {
  const enPath = join(__dirname, '../../../src/i18n/en/vcs.json')
  const zhPath = join(__dirname, '../../../src/i18n/zh/vcs.json')

  const errorKeys = [
    'errors.encryptionKeyNotConfigured',
    'errors.connectionNotFound',
    'errors.invalidProvider',
    'errors.invalidToken',
    'errors.issueAlreadySynced',
    'errors.invalidIssueNumber',
  ]

  errorKeys.forEach((key) => {
    test(`en/vcs.json contains ${key}`, () => {
      const content = readFileSync(enPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })

    test(`zh/vcs.json contains ${key}`, () => {
      const content = readFileSync(zhPath, 'utf-8')
      const json = JSON.parse(content)
      const keys = key.split('.')
      let value: any = json
      keys.forEach((k) => {
        value = value?.[k]
      })
      expect(value).toBeDefined()
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
    })
  })
})
