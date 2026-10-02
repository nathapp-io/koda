import { describe, test, expect } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>

function at(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)
}

function leafPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Tree).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

// The API's enumerations (S1 spec; slice 4 overview). Each one is rendered through a
// dynamic key (fleet.state.<STATE> ...), which used-keys-exist.spec cannot see.
const ENUMS: Record<string, string[]> = {
  'fleet.state': ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'],
  'fleet.misfit': ['disabled', 'offline', 'budget_paused', 'labels', 'executor', 'protocol', 'provider_missing', 'provider_unavailable', 'sandbox', 'tools', 'busy_repo', 'capacity'],
  'fleet.repoReason': [
    'github_app_not_configured', 'github_app_key_unreadable', 'app_not_installed', 'app_permissions_insufficient',
    'repo_not_found', 'provider_unreachable', 'provider_error', 'vcs_connection_missing', 'vcs_connection_mismatch',
    'vcs_encryption_key_missing', 'gitlab_token_invalid', 'gitlab_access_insufficient', 'gitlab_scope_missing',
  ],
  'fleet.common.ago': ['s', 'm', 'h', 'd'],
  'fleet.common.duration': ['s', 'm', 'h', 'd'],
  'fleet.repos.provider': ['github', 'gitlab'],
  'fleet.runners.chip.kind': ['api-key', 'oauth', 'exec', 'ambient', 'none'],
}

describe('Fleet locale parity (en and zh)', () => {
  test.each(['fleet', 'nav'])('%s has the same keys in en and zh, all non-empty', (subtree) => {
    const enNode = at(en, subtree)
    const zhNode = at(zh, subtree)
    expect(enNode).toBeDefined()
    expect(zhNode).toBeDefined()
    expect(leafPaths(zhNode).sort()).toEqual(leafPaths(enNode).sort())
    for (const leaf of leafPaths(zhNode)) {
      expect(String(at(zhNode as Tree, leaf) ?? '').trim()).not.toBe('')
    }
  })

  test.each(Object.entries(ENUMS))('%s covers exactly the API values', (path, values) => {
    expect(Object.keys(at(en, path) as Tree).sort()).toEqual([...values].sort())
  })

  // Parity, not copy: rewording an English label must not fail a green test.
  test.each(['nav.fleetRunners', 'nav.fleetRepos'])('%s is translated in both locales', (key) => {
    expect(String(at(en, key) ?? '').trim()).not.toBe('')
    expect(String(at(zh, key) ?? '').trim()).not.toBe('')
  })

  test('nav has the project fleet jobs link (slice 4c)', () => {
    expect(at(en, 'nav.fleetJobs')).toBe('Fleet jobs')
    expect(at(zh, 'nav.fleetJobs')).toBeTruthy()
  })

  test('no fleet message uses the vue-i18n plural or linked-message syntax by accident', () => {
    for (const leaf of leafPaths(at(en, 'fleet'))) {
      const value = String(at(en, `fleet.${leaf}`))
      expect(value).not.toMatch(/[|@]/)
    }
  })
})
