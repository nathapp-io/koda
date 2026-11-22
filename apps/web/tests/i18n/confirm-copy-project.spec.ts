import { describe, expect, test } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

type Messages = Record<string, unknown>
const value = (messages: Messages, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)

const COPY = {
  en: {
    'fleet.config.page.leaveConfirm': 'Leave with unsaved changes?',
    'fleet.flows.stop.confirmBody': 'The flow does not continue to its next step.',
    'kb.documents.deleteConfirmBody': 'Its indexed content is removed from search.',
    'fleet.config.page.leaveConfirmBody': 'Your edits to nax files are lost.',
    'fleet.config.page.leaveConfirmLabel': 'Leave',
  },
  zh: {
    'fleet.config.page.leaveConfirm': '离开并丢弃未保存的改动？',
    'fleet.flows.stop.confirmBody': '该流程将不再继续下一步。',
    'kb.documents.deleteConfirmBody': '其已索引内容将从搜索中移除。',
    'fleet.config.page.leaveConfirmBody': '你对 nax 文件的改动将丢失。',
    'fleet.config.page.leaveConfirmLabel': '离开',
  },
} as const

describe('project confirmation copy', () => {
  test.each([
    ['en', en, COPY.en],
    ['zh', zh, COPY.zh],
  ] as const)('%s contains exact row 14–16 copy', (_locale, messages, expected) => {
    for (const [key, text] of Object.entries(expected)) expect(value(messages, key)).toBe(text)
  })
})
