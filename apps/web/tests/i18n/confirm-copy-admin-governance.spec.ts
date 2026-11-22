import { describe, expect, test } from '@jest/globals'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import en from '../../i18n/locales/en.json'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import zh from '../../i18n/locales/zh.json'

const copy: Record<string, { en: string; zh: string }> = {
  'fleet.analytics.ingest.confirmRerunOutdatedBody': {
    en: 'Each bundle is read again with the current parser. This can take a while.',
    zh: '每个运行包都会用当前解析器重新读取，可能需要一些时间。',
  },
  'admin.roles.deleteConfirmBody': {
    en: 'This action cannot be undone.',
    zh: '此操作不可撤销。',
  },
  'approvals.policies.list.deleteConfirmBody': {
    en: 'Actions it covers no longer ask for approval under this policy.',
    zh: '其覆盖的操作将不再按此策略请求审批。',
  },
  'skills.confirm.removeBody': {
    en: 'Its skills are removed from the catalog.',
    zh: '其技能将从目录中移除。',
  },
}

function value(locale: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) =>
    (node as Record<string, unknown> | undefined)?.[part], locale)
}

describe('admin governance confirmation copy', () => {
  test('matches the design table in English and Chinese', () => {
    for (const [key, expected] of Object.entries(copy)) {
      expect(value(en, key)).toBe(expected.en)
      expect(value(zh, key)).toBe(expected.zh)
    }
  })
})
