import { describe, test, expect } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>
const at = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)

// S4a contract: fleet kinds and the params each message may use.
const FLEET_KINDS: Record<string, string[]> = {
  job_escalated: ['repo'], job_failed: ['repo'], job_crashed: ['repo'], job_pr_opened: ['repo'],
  approval_requested: ['kind', 'repo'],
  budget_warn: ['scope', 'spentUsd', 'amountUsd'], budget_hard_stop: ['scope', 'spentUsd', 'amountUsd'],
  runner_offline: ['runner'], credential_expiring: ['provider', 'runner', 'expiresAt'],
}

describe('notifications.kinds fleet strings (S4a Part D)', () => {
  test.each(Object.entries(FLEET_KINDS))('%s exists in en and zh with the same placeholders', (kind, params) => {
    for (const locale of [en, zh]) {
      const message = at(locale, `notifications.kinds.${kind}`)
      expect(typeof message).toBe('string')
      const used = [...(message as string).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
      expect(used).toEqual([...params].sort())
    }
  })
})
