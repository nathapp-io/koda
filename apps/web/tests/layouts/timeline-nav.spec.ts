import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')
const enLocalePath = join(webDir, 'i18n', 'locales', 'en.json')
const zhLocalePath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// Timeline AC9 — default layout exposes a /<slug>/timeline link in the
//                  project nav whose label resolves from `nav.timeline`
// ─────────────────────────────────────────────────────────────────────────────

describe('Timeline AC9: default layout has a /<slug>/timeline project nav link', () => {
  test('source contains a NuxtLink targeting /<slug>/timeline', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // The link must be rendered by NuxtLink (not just an anchor or text)
    // and must include the project-scoped path.
    const linkMatch = source.match(/<NuxtLink[\s\S]*?\/?\{`\/\$\{projectSlug\}\/timeline`\}[\s\S]*?<\/NuxtLink>/)
      ?? source.match(/<NuxtLink[\s\S]*?\$\{projectSlug\}\/timeline[\s\S]*?<\/NuxtLink>/)
    expect(linkMatch).not.toBeNull()
  })


  test('source uses nav.timeline i18n key for the link label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/t\(['"]nav\.timeline['"]\)/)
  })

  test('source places the timeline link inside the project-scoped nav block', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const scopedStart = source.indexOf('projectSlug')
    const scopedEnd = source.indexOf('</template>', scopedStart)
    expect(scopedStart).toBeGreaterThan(-1)
    expect(scopedEnd).toBeGreaterThan(scopedStart)
    const scopedSection = source.slice(scopedStart, scopedEnd)
    expect(scopedSection).toMatch(/\/timeline/)
    expect(scopedSection).toMatch(/nav\.timeline/)
  })

  test('Timeline NuxtLink appears after the KB NuxtLink in the project nav', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const kbIdx = source.indexOf('/kb')
    const timelineIdx = source.indexOf('/timeline')
    // Timeline link must come after KB link in the sidebar order
    expect(kbIdx).toBeGreaterThan(-1)
    expect(timelineIdx).toBeGreaterThan(kbIdx)
  })

  test('Clock icon is imported from lucide-vue-next and rendered inside the timeline NuxtLink', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Clock must be imported from lucide-vue-next in the script
    expect(source).toMatch(/import\s*\{[^}]*\bClock\b[^}]*\}\s*from\s*['"]lucide-vue-next['"]/)

    // Extract the timeline NuxtLink block to verify Clock is used there
    const timelineLink = source.match(/<NuxtLink[\s\S]*?\/timeline[\s\S]*?<\/NuxtLink>/)
    expect(timelineLink).not.toBeNull()
    const linkText = timelineLink?.[0] ?? ''
    expect(linkText).toContain('<Clock')
  })
})

describe('Timeline AC9: nav.timeline present in both en.json and zh.json', () => {
  test('en.json has nav.timeline as a non-empty string', () => {
    const en = JSON.parse(readFileSync(enLocalePath, 'utf-8'))
    expect(en.nav?.timeline).toBeDefined()
    expect(typeof en.nav.timeline).toBe('string')
    expect(en.nav.timeline.length).toBeGreaterThan(0)
  })

  test('zh.json has nav.timeline as a non-empty string', () => {
    const zh = JSON.parse(readFileSync(zhLocalePath, 'utf-8'))
    expect(zh.nav?.timeline).toBeDefined()
    expect(typeof zh.nav.timeline).toBe('string')
    expect(zh.nav.timeline.length).toBeGreaterThan(0)
  })
})
