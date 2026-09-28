import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'

const webDir = join(__dirname, '../..')
const SOURCE_DIRS = ['pages', 'components', 'composables', 'layouts', 'middleware', 'lib']
const LOCALES = ['en', 'zh'] as const
/** A literal key passed to t() or $t(). Dynamic keys (template literals) are not checked. */
const LITERAL_KEY = /\bt\(\s*['"]([A-Za-z0-9_.]+)['"]/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.spec.ts') ? [path] : []
  })
}

function hasKey(messages: unknown, key: string): boolean {
  return key.split('.').reduce<{ ok: boolean; node: unknown }>(
    (acc, part) => {
      if (!acc.ok || typeof acc.node !== 'object' || acc.node === null || !(part in acc.node)) {
        return { ok: false, node: undefined }
      }
      return { ok: true, node: (acc.node as Record<string, unknown>)[part] }
    },
    { ok: true, node: messages },
  ).ok
}

describe('every literal translation key exists in every locale', () => {
  const messages = Object.fromEntries(
    LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(webDir, 'i18n/locales', `${locale}.json`), 'utf-8'))]),
  )
  const used = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(webDir, dir))).flatMap((file) =>
    [...readFileSync(file, 'utf-8').matchAll(LITERAL_KEY)].map((match) => ({ key: match[1], file: relative(webDir, file) })),
  )

  it('finds keys to check (the scan is not vacuous)', () => {
    expect(used.length).toBeGreaterThan(100)
  })

  it.each(LOCALES)('%s has every key the source uses', (locale) => {
    const missing = used.filter(({ key }) => !hasKey(messages[locale], key)).map(({ key, file }) => `${key} (${file})`)
    expect([...new Set(missing)]).toEqual([])
  })
})
