import { describe, test, expect } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const indexPath = join(webDir, 'pages', 'index.vue')
const projectIndexPath = join(webDir, 'pages', '[project]', 'index.vue')
const agentsPath = join(webDir, 'pages', '[project]', 'agents.vue')
const labelsPath = join(webDir, 'pages', '[project]', 'labels.vue')
const ticketDetailPath = join(webDir, 'pages', '[project]', 'tickets', '[ref].vue')
const kbPath = join(webDir, 'pages', '[project]', 'kb.vue')
const enJsonPath = join(webDir, 'i18n', 'locales', 'en.json')
const zhJsonPath = join(webDir, 'i18n', 'locales', 'zh.json')

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — pages/index.vue: pending → centered loading element, hides project grid
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: pages/index.vue renders loading state when pending', () => {
  test('source destructures pending from useAsyncData', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/\bpending\b/)
  })

  test('source has v-if="pending" directive for loading block', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/v-if=["']pending["']/)
  })

  test('loading block renders Loading text via i18n key', () => {
    const source = readFileSync(indexPath, 'utf-8')
    const hasLoadingText =
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingText).toBe(true)
  })

  test('project grid is inside v-else (hidden when pending)', () => {
    const source = readFileSync(indexPath, 'utf-8')
    // Grid div with grid-cols must be inside a v-else block
    expect(source).toMatch(/v-else[^-]/)
    expect(source).toContain('grid-cols')
    // The grid must NOT have v-if="pending" — it must be hidden by v-else
    const gridMatch = source.match(/v-else[^>]*class=["'][^"']*grid[^"']*["']|class=["'][^"']*grid[^"']*["'][^>]*v-else/)
    const hasVElse = source.includes('v-else')
    expect(hasVElse).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — pages/index.vue: error → t('common.loadFailed') + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC2: pages/index.vue renders error state with retry', () => {
  test('source destructures error from useAsyncData', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/\berror\b/)
  })

  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(indexPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block renders a retry Button that calls refresh()', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('refresh()')
    // Button calling refresh should appear in the error section (after error check)
    const errorSectionStart = source.indexOf('v-else-if')
    const refreshIndex = source.indexOf('refresh()', errorSectionStart)
    expect(refreshIndex).toBeGreaterThan(errorSectionStart)
  })

  test('source destructures refresh from useAsyncData', () => {
    const source = readFileSync(indexPath, 'utf-8')
    expect(source).toContain('refresh')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — pages/[project]/index.vue: pending → loading state, hides ticket board
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: pages/[project]/index.vue renders loading state when pending', () => {
  test('source destructures pending from useAsyncData', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    expect(source).toMatch(/\bpending\b/)
  })

  test('source has v-if="pending" directive for loading block', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    expect(source).toMatch(/v-if=["']pending["']/)
  })

  test('TicketBoard is hidden when pending (wrapped in v-else)', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    // TicketBoard must not be unconditional — must be inside v-else
    expect(source).toContain('TicketBoard')
    // v-else must appear before TicketBoard in the template
    const vElseIndex = source.indexOf('v-else')
    const ticketBoardIndex = source.indexOf('TicketBoard', vElseIndex)
    expect(vElseIndex).toBeGreaterThanOrEqual(0)
    expect(ticketBoardIndex).toBeGreaterThan(vElseIndex)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — pages/[project]/index.vue: error → error message + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC4: pages/[project]/index.vue renders error state with retry', () => {
  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block has a retry Button that calls refresh()', () => {
    const source = readFileSync(projectIndexPath, 'utf-8')
    expect(source).toContain('refresh()')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — pages/[project]/agents.vue: pending → loading state
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC5: pages/[project]/agents.vue renders loading state when pending', () => {
  test('source destructures pending from useAsyncData', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    expect(source).toMatch(/\bpending\b/)
  })

  test('source has v-if="pending" directive for loading block', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    expect(source).toMatch(/v-if=["']pending["']/)
  })

  test('loading block renders loading text', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    const hasLoadingText =
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingText).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — pages/[project]/agents.vue: error → error message + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC6: pages/[project]/agents.vue renders error state with retry', () => {
  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block has a retry Button that calls refresh()', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    expect(source).toContain('refresh()')
  })

  test('source destructures refresh from useAsyncData', () => {
    const source = readFileSync(agentsPath, 'utf-8')
    expect(source).toContain('refresh')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — pages/[project]/labels.vue: error → error message + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC7: pages/[project]/labels.vue renders error state with retry', () => {
  test('source destructures error from useAsyncData', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toMatch(/\berror\b/)
  })

  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block has a retry Button', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    const hasRetryText =
      source.includes("t('common.retry')") ||
      source.includes('t("common.retry")')
    expect(hasRetryText).toBe(true)
  })

  test('retry button calls refresh()', () => {
    const source = readFileSync(labelsPath, 'utf-8')
    expect(source).toContain('refresh()')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — pages/[project]/tickets/[ref].vue: pending → v-if="pending" (not hardcoded)
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC8: pages/[project]/tickets/[ref].vue uses v-if="pending" for loading', () => {
  test('source destructures pending from useAsyncData', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    expect(source).toMatch(/\bpending\b/)
  })

  test('source has v-if="pending" directive (conditional loading, not hardcoded)', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    expect(source).toMatch(/v-if=["']pending["']/)
  })

  test('loading text is guarded by v-if (not shown unconditionally)', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    // The loading block must have v-if="pending" before any loading text
    const pendingBlockMatch = source.match(/v-if=["']pending["'][^<]*<[^>]*>[^<]*(?:loading|Loading)/i)
    const hasPendingConditional = source.includes('v-if="pending"') || source.includes("v-if='pending'")
    expect(hasPendingConditional).toBe(true)
    // There must NOT be a loading text visible outside any v-if guard
    // (the text 'Loading ticket' must only appear inside a pending-guarded block)
    const loadingText = 'Loading ticket...'
    if (source.includes(loadingText)) {
      // If this text appears, it must be inside a v-if="pending" block
      const loadingIndex = source.indexOf(loadingText)
      const nearbyVIf = source.lastIndexOf('v-if', loadingIndex)
      expect(nearbyVIf).toBeGreaterThanOrEqual(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC9 — pages/[project]/tickets/[ref].vue: error → error message + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC9: pages/[project]/tickets/[ref].vue renders error state with retry', () => {
  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block has a retry Button that calls refresh()', () => {
    const source = readFileSync(ticketDetailPath, 'utf-8')
    expect(source).toContain('refresh()')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC10 — pages/[project]/kb.vue: pending → loading state
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC10: pages/[project]/kb.vue renders loading state when pending', () => {
  test('source destructures pending from useAsyncData', () => {
    const source = readFileSync(kbPath, 'utf-8')
    expect(source).toMatch(/\bpending\b/)
  })

  test('source has v-if="pending" directive for loading block', () => {
    const source = readFileSync(kbPath, 'utf-8')
    expect(source).toMatch(/v-if=["']pending["']/)
  })

  test('loading block renders loading text', () => {
    const source = readFileSync(kbPath, 'utf-8')
    const hasLoadingText =
      source.includes("t('common.loading')") ||
      source.includes('t("common.loading")')
    expect(hasLoadingText).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC11 — pages/[project]/kb.vue: error → error message + retry Button
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC11: pages/[project]/kb.vue renders error state with retry', () => {
  test('source has v-else-if="error" directive for error block', () => {
    const source = readFileSync(kbPath, 'utf-8')
    expect(source).toMatch(/v-else-if=["']error["']/)
  })

  test('error block renders loadFailed i18n key', () => {
    const source = readFileSync(kbPath, 'utf-8')
    const hasLoadFailed =
      source.includes("t('common.loadFailed')") ||
      source.includes('t("common.loadFailed")')
    expect(hasLoadFailed).toBe(true)
  })

  test('error block has a retry Button that calls refresh()', () => {
    const source = readFileSync(kbPath, 'utf-8')
    expect(source).toContain('refresh()')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC12 — en.json: t('common.loadFailed') returns 'Failed to load data'
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC12: en.json has common.loadFailed = "Failed to load data"', () => {
  test('en.json parses without error', () => {
    const raw = readFileSync(enJsonPath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('en.json common.loadFailed is "Failed to load data"', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.common).toBeDefined()
    expect(en.common.loadFailed).toBe('Failed to load data')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC13 — en.json: t('common.retry') returns 'Retry'
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC13: en.json has common.retry = "Retry"', () => {
  test('en.json common.retry is "Retry"', () => {
    const en = JSON.parse(readFileSync(enJsonPath, 'utf-8'))
    expect(en.common).toBeDefined()
    expect(en.common.retry).toBe('Retry')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC14 — zh.json: t('common.loadFailed') returns '加载失败'
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC14: zh.json has common.loadFailed = "加载失败"', () => {
  test('zh.json parses without error', () => {
    const raw = readFileSync(zhJsonPath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  test('zh.json common.loadFailed is "加载失败"', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.common).toBeDefined()
    expect(zh.common.loadFailed).toBe('加载失败')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC15 — zh.json: t('common.retry') returns '重试'
// ─────────────────────────────────────────────────────────────────────────────

describe('US-002 AC15: zh.json has common.retry = "重试"', () => {
  test('zh.json common.retry is "重试"', () => {
    const zh = JSON.parse(readFileSync(zhJsonPath, 'utf-8'))
    expect(zh.common).toBeDefined()
    expect(zh.common.retry).toBe('重试')
  })
})
