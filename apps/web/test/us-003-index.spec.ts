import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '..')
const indexPath = join(webDir, 'pages', 'index.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — pages/index.vue fetches GET /projects via useApi() with useAsyncData
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC1: pages/index.vue fetches projects via useApi', () => {
  test('source imports or calls useApi', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('useApi')
  })

  test('source calls useAsyncData', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('useAsyncData')
  })

  test('source fetches /projects endpoint', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('/projects')
  })

  test('source calls $api.get inside useAsyncData', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/\$api\.get\s*\(\s*['"]\/projects['"]/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Projects rendered as Card grid with responsive columns
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC2: responsive project grid', () => {
  test('source has grid with responsive column classes', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('grid-cols-1')
    expect(source).toContain('sm:grid-cols-2')
    expect(source).toContain('lg:grid-cols-3')
  })

  test('source uses gap-4 in the grid', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('gap-4')
  })

  test('source renders Card component for each project', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('<Card')
  })

  test('source renders project name in each card', () => {
    const source = readFileSync(indexPath, 'utf-8')
    // Must reference project name (e.g. project.name)
    expect(source).toMatch(/project\.name/)
  })

  test('source renders key Badge in each card', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('<Badge')
    expect(source).toMatch(/project\.key/)
  })

  test('source renders truncated description', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/project\.description/)
    // Truncation via CSS class line-clamp or truncate
    const hasTruncation =
      source.includes('line-clamp') ||
      source.includes('truncate') ||
      source.includes('overflow-hidden')
    expect(hasTruncation).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — 'View Board' button navigates to /${project.slug}
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC3: View Board button navigates to project slug', () => {
  test("source contains 'View Board' text", () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('View Board')
  })

  test('source navigates to project slug route', () => {
    const source = readFileSync(indexPath, 'utf-8')
    // NuxtLink to /${project.slug} or navigateTo(`/${project.slug}`)
    const hasSlugRoute =
      source.includes('project.slug') &&
      (source.includes('NuxtLink') ||
        source.includes('navigateTo') ||
        source.includes(':to') ||
        source.includes(':href'))
    expect(hasSlugRoute).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — 'New Project' button opens CreateProjectDialog
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC4: New Project button opens CreateProjectDialog', () => {
  test("source contains 'New Project' text", () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('New Project')
  })

  test('source uses CreateProjectDialog component', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('CreateProjectDialog')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC10 — Empty state rendered when projects array is empty
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003 AC10: empty state rendered when no projects', () => {
  test('source has conditional rendering for empty state', () => {
    const source = readFileSync(indexPath, 'utf-8')
    // v-if checking for empty projects array
    const hasEmptyCheck =
      source.includes('v-if') ||
      source.includes('v-else') ||
      source.includes('length === 0') ||
      source.includes('!projects') ||
      source.includes('.length')
    expect(hasEmptyCheck).toBe(true)
  })

  test('source renders an empty state message', () => {
    const source = readFileSync(indexPath, 'utf-8')
    const hasEmptyMessage =
      source.includes('No projects') ||
      source.includes('no projects') ||
      source.includes('empty') ||
      source.includes('get started')
    expect(hasEmptyMessage).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Quality — no console.log
// ──────────────────────────────────────────────────────────────────────────────

describe('US-003: pages/index.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
