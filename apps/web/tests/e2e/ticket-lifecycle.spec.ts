import { test, expect } from '@playwright/test';
import { login, createProject, createTicket, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin, confirmTransitionDialog } from './fixtures/page-helpers';

/**
 * Ticket lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
 *
 * Transition map (from TicketActionPanel.vue):
 *   CREATED    → "Verify" (opens dialog) or "Reject"
 *   VERIFIED   → "Start" (no dialog)
 *   IN_PROGRESS → "Submit Fix" (opens dialog) or "Reject"
 *   VERIFY_FIX  → "Approve Fix" (opens dialog) or "Fail Fix"
 */
test.describe('Ticket Lifecycle', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

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

  test('can create a ticket via dialog', async ({ page }) => {
    await webLogin(page);
    await page.goto(`/${projectSlug}`);

    await page.getByRole('button', { name: 'New Ticket' }).click();

    await page.locator('input[name="title"]').fill('E2E Bug — login crash on mobile');

    // Radix Select for type — click the trigger then pick option
    await page.locator('button[role="combobox"]').first().click();
    await page.getByRole('option', { name: 'Bug' }).click();

    await page.getByRole('button', { name: 'Create Ticket' }).click();

    await expect(page.getByText('E2E Bug — login crash on mobile')).toBeVisible({ timeout: 5000 });
  });

  test('ticket starts in CREATED status', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Status Check',
      type: 'BUG',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Verify the CREATED action buttons are present (Verify + Reject)
    await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();
  });

  test('CREATED → VERIFIED: clicking Verify opens dialog and transitions', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Verify Transition',
      type: 'BUG',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await page.getByRole('button', { name: 'Verify' }).click();
    await confirmTransitionDialog(page, 'Verified by E2E test');

    // After transition, VERIFIED state shows "Start" button
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 5000 });
  });

  test('VERIFIED → IN_PROGRESS: clicking Start transitions without dialog', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: 'E2E Start', type: 'BUG' });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // Verify first
    await page.getByRole('button', { name: 'Verify' }).click();
    await confirmTransitionDialog(page);
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 4000 });

    // Start
    await page.getByRole('button', { name: 'Start' }).click();
    // IN_PROGRESS shows "Submit Fix"
    await expect(page.getByRole('button', { name: 'Submit Fix' })).toBeVisible({ timeout: 4000 });
  });

  test('full lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Full Lifecycle Ticket',
      type: 'BUG',
      priority: 'HIGH',
    });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    // CREATED → VERIFIED
    await page.getByRole('button', { name: 'Verify' }).click();
    await confirmTransitionDialog(page, 'Verified');
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 4000 });

    // VERIFIED → IN_PROGRESS
    await page.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByRole('button', { name: 'Submit Fix' })).toBeVisible({ timeout: 4000 });

    // IN_PROGRESS → VERIFY_FIX
    await page.getByRole('button', { name: 'Submit Fix' }).click();
    await confirmTransitionDialog(page, 'Fix submitted');
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeVisible({ timeout: 4000 });

    // VERIFY_FIX → CLOSED
    await page.getByRole('button', { name: 'Approve Fix' }).click();
    await confirmTransitionDialog(page, 'Fix approved');

    // CLOSED state — no action buttons, status badge should reflect CLOSED
    await expect(page.getByRole('button', { name: 'Approve Fix' })).not.toBeVisible({ timeout: 3000 });
  });
});
