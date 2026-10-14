import { describe, expect, test } from '@jest/globals'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'

/**
 * US-004 AC-15: the marker and card copy is pinned in both locales. A new marker kind or card line
 * needs its key here, and every key must exist in English and Chinese.
 */

type Tree = { [key: string]: string | Tree }

const leaf = (tree: Tree, path: string): unknown =>
  path.split('.').reduce<unknown>((node, part) => (node as Tree | undefined)?.[part], tree)

const MARKER_KEYS = [
  'marker.published',
  'marker.publishFailed',
  'marker.publishFailedBranchMoved',
  'marker.discarded',
  'marker.discardFailed',
  'markerPaths',
  'markerIgnored',
]

const CARD_KEYS = ['card.plan', 'card.run', 'card.openJob', 'card.pr', 'card.needsYou']

const PREFIX = 'fleet.threads.handoff'

describe('US-004 AC-15: marker and card locale keys', () => {
  test('AC-15: every marker and card key is a non-empty string in en.json and zh.json', () => {
    for (const key of [...MARKER_KEYS, ...CARD_KEYS]) {
      const path = `${PREFIX}.${key}`
      const enValue = leaf(en as unknown as Tree, path)
      const zhValue = leaf(zh as unknown as Tree, path)
      expect({ path, en: typeof enValue === 'string' && enValue.length > 0 }).toEqual({ path, en: true })
      expect({ path, zh: typeof zhValue === 'string' && zhValue.length > 0 }).toEqual({ path, zh: true })
    }
  })

  test('AC-15: the marker subtree holds exactly the pinned kinds in both locales', () => {
    for (const locale of [en, zh]) {
      const marker = leaf(locale as unknown as Tree, `${PREFIX}.marker`) as Tree
      expect(Object.keys(marker).sort()).toEqual(['discardFailed', 'discarded', 'publishFailed', 'publishFailedBranchMoved', 'published'])
    }
  })

  test('AC-15: the card subtree holds exactly the pinned lines in both locales', () => {
    for (const locale of [en, zh]) {
      const card = leaf(locale as unknown as Tree, `${PREFIX}.card`) as Tree
      expect(Object.keys(card).sort()).toEqual(['needsYou', 'openJob', 'plan', 'pr', 'run'])
    }
  })

  test('AC-15: marker and card copy contains no pipe or at-sign, the characters the fleet parity spec bans', () => {
    for (const locale of [en, zh]) {
      const handoff = leaf(locale as unknown as Tree, PREFIX) as Tree
      const texts: string[] = []
      const walk = (node: Tree | string): void => {
        if (typeof node === 'string') texts.push(node)
        else Object.values(node).forEach(walk)
      }
      walk(handoff.marker as Tree)
      walk(handoff.card as Tree)
      for (const text of texts) expect(text).not.toMatch(/[|@]/)
    }
  })
})
