import { describe, expect, test } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

function value(locale: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, locale)
}

describe('US-001 confirmation copy', () => {
  test('AC-11: en and zh use the exact titles and dialog bodies', () => {
    const expected = {
      'vcs.secret.rotateConfirm': ['Rotate the webhook secret?', '确定轮换 Webhook 密钥？'],
      'projects.settings.deleteConfirm': ['Delete this project?', '确认删除此项目？'],
      'vcs.secret.rotateConfirmBody': ['Deliveries signed with the old secret will be rejected.', '使用旧密钥签名的投递将被拒绝。'],
      'fleet.providerKeys.deleteConfirmBody': ['The stored key is removed and cannot be recovered.', '已保存的密钥将被移除，且无法恢复。'],
      'projects.invites.cancelConfirmBody': ['The invite link stops working.', '该邀请链接将失效。'],
      'projects.members.removeConfirmBody': ['All of their roles in this project are removed.', '其在此项目中的所有角色将被移除。'],
      'projects.settings.deleteConfirmBody': ['This action cannot be undone.', '此操作不可撤销。'],
    } as const
    for (const [key, [english, chinese]] of Object.entries(expected)) {
      expect(value(en, key)).toBe(english)
      expect(value(zh, key)).toBe(chinese)
    }
  })
})
