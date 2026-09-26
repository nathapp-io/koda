import { describe, test, expect } from '@jest/globals'

const en = require('../../i18n/locales/en.json') as Record<string, unknown>
const zh = require('../../i18n/locales/zh.json') as Record<string, unknown>

type Tree = Record<string, unknown>

function at(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree)
}

/** Every leaf path under `node`, e.g. ['form.title', 'toast.created']. */
function leafPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix]
  return Object.entries(node as Tree).flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key))
}

// Subtrees added or extended by Track 1 Slice 4.
const SUBTREES = ['admin.users', 'auth.register', 'auth.validation', 'nav', 'projects.members']

describe('Slice 4 locale parity (en ⇄ zh)', () => {
  test.each(SUBTREES)('%s has the same keys in en and zh, all non-empty', (subtree) => {
    const enNode = at(en, subtree)
    const zhNode = at(zh, subtree)
    expect(enNode).toBeDefined()
    expect(zhNode).toBeDefined()
    expect(leafPaths(zhNode).sort()).toEqual(leafPaths(enNode).sort())
    for (const leaf of leafPaths(zhNode)) {
      expect(String(at(zhNode as Tree, leaf) ?? '').trim()).not.toBe('')
    }
  })
})
