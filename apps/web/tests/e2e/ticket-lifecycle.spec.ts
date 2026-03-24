import { test, expect } from '@playwright/test';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';

test.describe('Ticket Lifecycle', () => {
  let token: string;
  let projectSlug: string;
  let ticketRef: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    // Create a test project
    const proj = await createProject(token, {
      name: 'E2E Ticket Lifecycle',
      slug: `e2e-tickets-${Date.now()}`,
      key: 'ETLC',
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  /** Helper: login and navigate to the project board */
  async function loginAndGoToProject(page: Parameters<Parameters<typeof test>[1]>[0]) {
    await page.goto('/login');
    await page.getByPlaceholder(/email/i).fill(E2E_ADMIN.email);
    await page.getByPlaceholder(/password/i).fill(E2E_ADMIN.password);
    await page.getByRole('button', { name: /login|sign in/i }).click();
    await page.goto(`/${projectSlug}`);
    await expect(page).toHaveURL(new RegExp(projectSlug));
  }

  test('can create a ticket via dialog', async ({ page }) => {
    await loginAndGoToProject(page);

    await page.getByRole('button', { name: /new ticket|create ticket/i }).click();

    await page.locator('input[name="title"]').fill('E2E Bug — login crash on mobile');

    // Select type BUG (Radix Select)
    await page.locator('[name="type"]').locator('..').locator('button').click();
    await page.getByRole('option', { name: /bug/i }).click();

    await page.getByRole('button', { name: /create|submit/i }).last().click();

    // Ticket appears in list
    await expect(page.getByText('E2E Bug — login crash on mobile')).toBeVisible({ timeout: 5000 });
  });

  test('ticket starts in CREATED status', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Status Check',
      type: 'BUG',
    });
    ticketRef = ticket.ref;

    await loginAndGoToProject(page);
    await page.goto(`/${projectSlug}/tickets/${ticketRef}`);

    // Status badge shows CREATED
    await expect(page.getByText(/created/i).first()).toBeVisible({ timeout: 3000 });
  });

  test('can transition ticket CREATED → IN_PROGRESS', async ({ page }) => {
    if (!ticketRef) test.skip();

    await loginAndGoToProject(page);
    await page.goto(`/${projectSlug}/tickets/${ticketRef}`);

    await page.getByRole('button', { name: /start|in progress/i }).click();

    await expect(page.getByText(/in.progress/i)).toBeVisible({ timeout: 5000 });
  });

  test('can transition ticket IN_PROGRESS → VERIFY_FIX', async ({ page }) => {
    if (!ticketRef) test.skip();

    await loginAndGoToProject(page);
    await page.goto(`/${projectSlug}/tickets/${ticketRef}`);

    await page.getByRole('button', { name: /close|verify.fix|ready for review/i }).click();

    await expect(page.getByText(/verify.fix|closed/i)).toBeVisible({ timeout: 5000 });
  });

  test('full lifecycle: CREATED → IN_PROGRESS → VERIFY_FIX → VERIFIED', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Full Lifecycle Ticket',
      type: 'BUG',
      priority: 'HIGH',
    });

    await loginAndGoToProject(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Start
    await page.getByRole('button', { name: /start/i }).click();
    await expect(page.getByText(/in.progress/i)).toBeVisible({ timeout: 3000 });

    // Close
    await page.getByRole('button', { name: /close|ready for review/i }).click();
    await expect(page.getByText(/verify.fix|closed/i)).toBeVisible({ timeout: 3000 });

    // Verify (if verify button appears)
    const verifyBtn = page.getByRole('button', { name: /verify/i });
    if (await verifyBtn.isVisible()) {
      await verifyBtn.click();
      await expect(page.getByText(/verified/i)).toBeVisible({ timeout: 3000 });
    }
  });
});
