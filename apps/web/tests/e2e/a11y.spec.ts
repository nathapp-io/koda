import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page) {
  return new AxeBuilder({ page }).withTags(TAGS).analyze();
}

type ScanResult = Awaited<ReturnType<typeof scan>>;

function seriousViolations(violations: ScanResult) {
  return violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
}

test.describe('a11y (axe, serious+critical)', () => {
  let token: string;
  let slug: string;
  let ticketRef: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const proj = await createProject(token, {
      name: 'E2E A11y Project',
      slug: `e2e-a11y-${Date.now()}`,
      key: generateUniqueProjectKey('A1'),
    });
    slug = proj.slug;
    const t = await createTicket(token, slug, {
      title: 'A11y sample ticket',
      type: 'BUG',
      priority: 'HIGH',
      description: 'Body for the a11y scan.',
    });
    ticketRef = t.ref;
  });

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug);
  });

  const pages: Array<{ name: string; path: () => string }> = [
    { name: 'dashboard', path: () => '/' },
    { name: 'board', path: () => `/${slug}` },
    { name: 'ticket detail', path: () => `/${slug}/tickets/${ticketRef}` },
    { name: 'labels', path: () => `/${slug}/labels` },
    { name: 'agents', path: () => '/agents' },
    { name: 'project agents roster', path: () => `/${slug}/agents` },
  ];

  async function expectNoSeriousViolations(page: Page) {
    const { violations } = await scan(page);
    const serious = seriousViolations(violations);
    expect(
      serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target) })),
      JSON.stringify(serious.map((v) => v.help)),
    ).toEqual([]);
  }

  for (const { name, path } of pages) {
    test(`light: ${name} has no serious/critical violations`, async ({ page }) => {
      await webLogin(page);
      await page.goto(path());
      await expect(page.locator('main#main')).toBeVisible();
      await expectNoSeriousViolations(page);
    });

    test(`dark: ${name} has no serious/critical violations`, async ({ page }) => {
      await webLogin(page);
      await page.goto(path());
      await expect(page.locator('main#main')).toBeVisible();
      // darkMode: 'class' — swapping html.light for html.dark is exactly what
      // the ThemeSwitcher produces. The wait lets the CSS color transitions
      // settle, so axe never samples mid-transition colors.
      await page.evaluate(() => {
        document.documentElement.classList.remove('light');
        document.documentElement.classList.add('dark');
      });
      await page.waitForTimeout(300);
      await expectNoSeriousViolations(page);
    });
  }

  test('light: login page has no serious/critical violations', async ({ page }) => {
    // Fresh context per test — this page is intentionally logged out.
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in|login/i })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('dark: login page has no serious/critical violations', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in|login/i })).toBeVisible();
    // darkMode: 'class' — swapping html.light for html.dark is exactly what
    // the ThemeSwitcher produces. The wait lets the CSS color transitions
    // settle, so axe never samples mid-transition colors.
    await page.evaluate(() => {
      document.documentElement.classList.remove('light');
      document.documentElement.classList.add('dark');
    });
    await page.waitForTimeout(300);
    await expectNoSeriousViolations(page);
  });
});
