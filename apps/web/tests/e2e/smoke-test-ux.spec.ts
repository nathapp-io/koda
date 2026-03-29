import { test, expect, Page } from '@playwright/test'

const BASE = 'http://localhost:3101'
const API = 'http://localhost:3100'

test.describe('Koda UX Smoke Test', () => {
  let page: Page

  test.beforeAll(async ({ browser }) => {
    // Use persistent context to reuse auth state
    const context = await browser.newContext()
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await page.close()
  })

  // ── Helper: wait for toast and return its position ──────────────────────
  async function getToastPosition(page: Page) {
    const toast = page.locator('[data-sonner-toast], [class*="toast"]').first()
    if (await toast.isVisible({ timeout: 5000 })) {
      const box = await toast.boundingBox()
      return box
    }
    return null
  }

  // ── Test 1: Login page ─────────────────────────────────────────────────
  test('login page loads with correct elements', async () => {
    await page.goto(`${BASE}/login`)
    await expect(page.locator('h2:has-text("Koda")')).toBeVisible()
    await expect(page.locator('input[type="email"], input[placeholder*="email"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible()
  })

  // ── Test 2: Register → dashboard ──────────────────────────────────────
  test('register creates account and shows dashboard', async () => {
    // Seed a fresh user first via API so registration doesn't conflict
    const unique = Date.now()
    const email = `smoke${unique}@test.local`
    const name = 'Smoke Test'
    const password = 'SmokeTest123!'

    await page.goto(`${BASE}/register`)
    await page.fill('input[placeholder="John Doe"]', name)
    await page.fill('input[placeholder*="email"]', email)
    await page.fill('input[type="password"]', password)
    await page.click('button:has-text("Create account")')
    await page.waitForURL(`${BASE}/`, { timeout: 10000 })
    await expect(page.locator('h1:has-text("Projects")')).toBeVisible()
  })

  // ── Test 3: Create project ─────────────────────────────────────────────
  test('create project shows in dashboard', async () => {
    const slug = `smoke-proj-${Date.now()}`
    await page.click('button:has-text("New Project")')
    await page.waitForSelector('[role="dialog"], dialog', { timeout: 5000 })
    await page.fill('input[placeholder*="slug" i], input[id*="slug" i]', slug)
    // Find and fill the name field (might be "name" or "project name")
    const nameInput = page.locator('input[type="text"]').first()
    await nameInput.fill(slug)
    await page.click('button:has-text("Create"), button:has-text("create")')
    await page.waitForTimeout(2000)
    // Should show the project on dashboard
    await expect(page.locator(`text=${slug}`).first()).toBeVisible()
  })

  // ── Test 4: Kanban board ───────────────────────────────────────────────
  test('kanban board loads with columns', async () => {
    const projectLink = page.locator('a[href*="/"][href!="/"]').first()
    const href = await projectLink.getAttribute('href')
    await page.goto(`${BASE}${href}`)
    await page.waitForLoadState('networkidle')

    // Check columns exist
    await expect(page.locator('text=CREATED')).toBeVisible()
    await expect(page.locator('text=VERIFIED')).toBeVisible()
    await expect(page.locator('text=IN_PROGRESS')).toBeVisible()
    await expect(page.locator('button:has-text("New Ticket")')).toBeVisible()
  })

  // ── Test 5: Create ticket → toast top-right ─────────────────────────────
  test('create ticket shows toast at top-right', async () => {
    await page.click('button:has-text("New Ticket")')
    await page.waitForSelector('[role="dialog"], dialog', { timeout: 5000 })

    // Fill required fields
    await page.fill('input[placeholder*="description" i]', 'Smoke test ticket')
    
    // Type selector — click the combobox trigger then pick first option
    const typeCombo = page.locator('[role="combobox"]').first()
    await typeCombo.click()
    await page.waitForTimeout(500)
    const firstOption = page.locator('[role="option"], [role="listbox"] [role="option"]').first()
    if (await firstOption.isVisible({ timeout: 3000 })) {
      await firstOption.click()
    } else {
      // Try pressing down + enter
      await typeCombo.press('ArrowDown')
      await typeCombo.press('Enter')
    }

    // Submit
    await page.click('button:has-text("Create Ticket")')
    await page.waitForTimeout(1000)

    // Check toast position
    const toast = page.locator('[data-sonner-toast], [class*="toast"]').first()
    if (await toast.isVisible({ timeout: 5000 })) {
      const box = await toast.boundingBox()
      const viewport = page.viewportSize()!
      // top-right: x should be in the right half, y should be in top quarter
      console.log(`Toast position: x=${box?.x}, y=${box?.y}, w=${box?.width}, h=${box?.height}`)
      console.log(`Viewport: ${viewport.width}x${viewport.height}`)
      const isTopRight = (box?.x ?? 0) > viewport.width * 0.4 && (box?.y ?? 0) < viewport.height * 0.4
      expect(isTopRight).toBe(true)
    }
  })

  // ── Test 6: Sidebar active state ──────────────────────────────────────
  test('sidebar shows active state on current page', async () => {
    const boardLink = page.locator('nav a[href*="/"]').filter({ hasText: 'Board' }).first()
    await boardLink.click()
    await page.waitForLoadState('networkidle')

    const activeLink = page.locator('a[aria-current="page"], nav a[class*="active"]').first()
    const activeText = await activeLink.textContent()
    console.log(`Active nav: ${activeText?.trim()}`)
    // Active state should be present
    const hasActive = await page.locator('nav a[class*="active"], nav a[aria-current="page"]').count()
    expect(hasActive).toBeGreaterThan(0)
  })

  // ── Test 7: Breadcrumb ─────────────────────────────────────────────────
  test('breadcrumb shows Koda > project on board page', async () => {
    const breadcrumb = page.locator('nav[aria-label="breadcrumb"], nav:has-text("Koda")').first()
    const text = await breadcrumb.textContent()
    console.log(`Breadcrumb text: ${text}`)
    await expect(page.locator('text=Koda')).toBeVisible()
    // Should contain project slug or name
    const projectBreadcrumb = page.locator('nav').filter({ hasText: /Koda.*\// }).first()
    await expect(projectBreadcrumb).toBeVisible()
  })

  // ── Test 8: Agents page ───────────────────────────────────────────────
  test('agents page loads', async () => {
    const currentUrl = page.url()
    const projectMatch = currentUrl.match(/\/([^/]+)$/)
    if (projectMatch) {
      await page.goto(`${BASE}/${projectMatch[1]}/agents`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('h1:has-text("Agents")')).toBeVisible()
    }
  })

  // ── Test 9: Labels page ───────────────────────────────────────────────
  test('labels page loads', async () => {
    const currentUrl = page.url()
    const projectMatch = currentUrl.match(/\/([^/]+)$/)
    if (projectMatch) {
      await page.goto(`${BASE}/${projectMatch[1]}/labels`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('h1:has-text("Labels")')).toBeVisible()
    }
  })

  // ── Test 10: KB page ──────────────────────────────────────────────────
  test('kb page loads', async () => {
    const currentUrl = page.url()
    const projectMatch = currentUrl.match(/\/([^/]+)$/)
    if (projectMatch) {
      await page.goto(`${BASE}/${projectMatch[1]}/kb`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('h1:has-text("Knowledge Base")')).toBeVisible()
    }
  })
})
