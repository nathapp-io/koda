import { describe, test, expect } from '@jest/globals'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const webDir = join(__dirname, '../..')
const layoutPath = join(webDir, 'layouts', 'default.vue')

// ──────────────────────────────────────────────────────────────────────────────
// AC1 — layouts/default.vue created with fixed sidebar (w-56), nav links
//        (Dashboard, Projects), bottom user section
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC1: layouts/default.vue exists', () => {
  test('file is present at layouts/default.vue', () => {
    expect(existsSync(layoutPath)).toBe(true)
  })
})

describe('US-002 AC1: sidebar has w-56 fixed width', () => {
  test('source contains w-56 class for sidebar width', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('w-56')
  })

  test('source contains fixed or sticky positioning for sidebar', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/\bfixed\b|\bsticky\b/)
  })
})

describe('US-002 AC1: sidebar has Dashboard and Projects navigation links', () => {
  test('source contains Dashboard navigation link text', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('Dashboard')
  })

  test('source contains Projects navigation link text', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('Projects')
  })

  test('source uses NuxtLink for navigation items', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('NuxtLink')
  })
})

describe('US-002 AC1: sidebar has bottom user section', () => {
  test('source renders user information in sidebar', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Must reference the user object from useAuth
    expect(source).toMatch(/user\.email|user\.name|auth\.user/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC2 — Top header renders dark mode toggle button using useColorMode()
//        with sun/moon icon swap
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC2: header has dark mode toggle using useColorMode()', () => {
  test('source calls useColorMode composable', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('useColorMode')
  })

  test('source contains sun icon (LucideSun)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/LucideSun/)
  })

  test('source contains moon icon (LucideMoon)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/LucideMoon/)
  })

  test('dark mode toggle button is in the header area', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Both the header and the color mode toggle must be present
    expect(source).toContain('useColorMode')
    expect(source).toMatch(/LucideSun|LucideMoon/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC3 — Dark mode toggle correctly switches class-based dark mode via
//        colorMode.preference
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC3: dark mode toggle assigns to colorMode.preference', () => {
  test('source assigns value to colorMode.preference', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('colorMode.preference')
  })

  test('toggle switches between dark and light values', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    // Must reference both 'dark' and 'light' strings for the toggle logic
    expect(source).toContain('dark')
    expect(source).toContain('light')
  })

  test('toggle reads colorMode.value to determine current state', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('colorMode.value')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC4 — Sidebar shows current user name from useAuth().user
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC4: sidebar displays user from useAuth().user', () => {
  test('source imports or calls useAuth composable', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('useAuth')
  })

  test('source accesses .user from the auth object', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/auth\.user|\.user\b/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC5 — Logout button in sidebar/header calls useAuth().logout()
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC5: logout button calls useAuth().logout()', () => {
  test('source contains a logout action reference', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/logout\(\)|auth\.logout/)
  })

  test('source has a logout button or clickable element with Logout label', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/[Ll]ogout/)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// AC6 — Mobile sidebar toggles visibility via v-show and a local ref,
//        not CSS media breakpoints
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002 AC6: mobile sidebar uses v-show with a local ref', () => {
  test('source uses v-show directive for sidebar visibility toggle', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('v-show')
  })

  test('source declares a ref() for sidebar open/close state', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('ref(')
  })

  test('v-show and ref are both present (JS-controlled toggle, not CSS-only)', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    const hasVShow = source.includes('v-show')
    const hasRef = source.includes('ref(')
    expect(hasVShow && hasRef).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Main content area — renders <slot /> with px-6 py-4 padding
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: main content area renders slot with px-6 py-4 padding', () => {
  test('source contains <slot /> for page content injection', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toMatch(/<slot\s*\/>|<slot><\/slot>/)
  })

  test('content area has px-6 padding class', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('px-6')
  })

  test('content area has py-4 padding class', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).toContain('py-4')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Code quality
// ──────────────────────────────────────────────────────────────────────────────

describe('US-002: layouts/default.vue has no console.log statements', () => {
  test('source does not contain console.log', () => {
    const source = readFileSync(layoutPath, 'utf-8')
    expect(source).not.toContain('console.log')
  })
})
