import { test, expect } from '@jest/globals'
import en from '../../i18n/locales/en.json'
import zh from '../../i18n/locales/zh.json'

test('AC-11 account and navigation keys exist in both locales', () => {
  const locales = [en, zh] as unknown as Array<{ auth: { account: Record<string, string> }; nav: { account: string } }>
  const keys = ['title', 'currentPassword', 'newPassword', 'confirmNewPassword', 'currentRequired', 'minimum', 'mismatch', 'currentPasswordWrong', 'success', 'submit']
  for (const locale of locales) {
    expect(Object.keys(locale.auth.account).sort()).toEqual(keys.sort())
    for (const key of keys) expect(locale.auth.account[key]).toBeTruthy()
    expect(locale.nav.account).toBeTruthy()
  }
})
