import { describe, expect, test } from '@jest/globals'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import en from '../../i18n/locales/en.json'
// eslint-disable-next-line @typescript-eslint/no-require-imports
import zh from '../../i18n/locales/zh.json'

const copy: Record<string, { en: string; zh: string }> = {
  'fleet.repos.deleteConfirm': { en: 'Unregister {repo}?', zh: '取消注册 {repo}？' },
  'fleet.runners.deleteConfirm': { en: 'Delete runner {name}?', zh: '删除执行机 {name}？' },
  'fleet.repos.deleteConfirmBody': { en: 'A repo with unfinished jobs cannot be removed.', zh: '有未完成任务的仓库无法移除。' },
  'fleet.runners.deleteConfirmBody': {
    en: 'Its key is revoked. A runner with unfinished or pinned jobs cannot be deleted.',
    zh: '其密钥将被吊销。有未完成任务或被固定任务的执行机无法删除。',
  },
}

function value(locale: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) =>
    (node as Record<string, unknown> | undefined)?.[part], locale)
}

describe('admin fleet confirmation copy', () => {
  test('matches the design table in English and Chinese', () => {
    for (const [key, expected] of Object.entries(copy)) {
      expect(value(en, key)).toBe(expected.en)
      expect(value(zh, key)).toBe(expected.zh)
    }
  })
})
