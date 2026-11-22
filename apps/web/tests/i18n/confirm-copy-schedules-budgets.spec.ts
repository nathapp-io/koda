import { describe, expect, test } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

type Messages = Record<string, unknown>
const value = (messages: Messages, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages)

const COPY = {
  en: {
    'fleet.schedules.deleteConfirm': 'Delete schedule {name}?',
    'fleet.budgets.deleteConfirm': 'Delete the budget policy for {scope}?',
    'fleet.schedules.deleteConfirmBody': 'The jobs it dispatched are kept.',
    'fleet.budgets.deleteConfirmBody': 'A paused scope resumes immediately.',
  },
  zh: {
    'fleet.schedules.deleteConfirm': '删除定时计划 {name}？',
    'fleet.budgets.deleteConfirm': '删除 {scope} 的预算策略？',
    'fleet.schedules.deleteConfirmBody': '它派发过的任务会保留。',
    'fleet.budgets.deleteConfirmBody': '已暂停的范围将立即恢复。',
  },
} as const

describe('schedule and budget confirmation copy', () => {
  test.each([
    ['en', en, COPY.en],
    ['zh', zh, COPY.zh],
  ] as const)('%s contains exact row 17–18 copy', (_locale, messages, expected) => {
    for (const [key, text] of Object.entries(expected)) expect(value(messages, key)).toBe(text)
  })
})
