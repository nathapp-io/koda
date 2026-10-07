import { test, expect } from '@playwright/test';
import {
  login,
  createProject,
  createTicket,
  deleteProject,
  transitionTicket,
  E2E_ADMIN,
} from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey, waitForHydration } from './fixtures/page-helpers';

/**
 * Ticket lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
 *
 * The action buttons come from the API's `allowedActions` for the current
 * user (M25), not from a client-side transition map. Dialog behavior:
 *   "Verify", "Submit Fix", "Approve Fix" and "Close" open the comment
 *   dialog; "Start" transitions without a dialog. "Close" is offered only
 *   to a project or global ADMIN, and requires a non-empty reason.
 */
test.describe('Ticket Lifecycle', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    const suffix = Date.now().toString().slice(-6);

    const proj = await createProject(token, {
      name: 'E2E Ticket Lifecycle',
      slug: `e2etl${suffix}`,
      key: generateUniqueProjectKey('TL'),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('board shows New Ticket action', async ({ page }) => {
    await webLogin(page);
    await page.goto(`/${projectSlug}`);

    const board = page.locator('.overflow-x-auto').first();
    await expect(board.getByRole('button', { name: 'New Ticket' })).toBeVisible();
  });

  test('creates a ticket through the New Ticket dialog', async ({ page }) => {
    // Regression for #232: the shadcn Select listbox was portaled to <body>
    // and inherited the modal dialog's `pointer-events: none`, so Type could
    // never be picked and the required field blocked submission. Type and
    // Priority are now dialog-safe native selects.
    const title = `E2E Dialog Ticket ${Date.now()}`;

    await webLogin(page);
    await page.goto(`/${projectSlug}`);
    await waitForHydration(page);

    const board = page.locator('.overflow-x-auto').first();
    await board.getByRole('button', { name: 'New Ticket' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByTestId('create-ticket-type').selectOption('BUG');
    await dialog.getByTestId('create-ticket-priority').selectOption('HIGH');
    await dialog.getByRole('button', { name: 'Create Ticket' }).click();

    await expect(board.getByText(title)).toBeVisible({ timeout: 5000 });
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

  test('CREATED → VERIFIED: UI shows Start after verify transition', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Verify Transition',
      type: 'BUG',
    });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^VERIFIED$/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 5000 });
  });

  test('CREATED → VERIFIED through the Verify dialog sends the typed comment', async ({ page }) => {
    // Regression: ui/textarea did not sync v-model, so Confirm posted {} and got 400.
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Verify Dialog',
      type: 'BUG',
    });
    const body = `Verified via dialog ${Date.now()}`;

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);
    await waitForHydration(page);
    await page.getByRole('button', { name: 'Verify' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Enter a comment or reason...').fill(body);
    await dialog.getByRole('button', { name: 'Confirm' }).click();

    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(body)).toBeVisible({ timeout: 5000 });
  });

  test('VERIFIED → IN_PROGRESS: UI shows Submit Fix after start transition', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: 'E2E Start', type: 'BUG' });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'start');

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^IN_PROGRESS$/)).toBeVisible({ timeout: 4000 });
    await expect(page.getByRole('button', { name: 'Submit Fix' })).toBeVisible({ timeout: 4000 });
  });

  test('full lifecycle: CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, {
      title: 'E2E Full Lifecycle Ticket',
      type: 'BUG',
      priority: 'HIGH',
    });

    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'Verified in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'start');
    await transitionTicket(token, projectSlug, ticket.ref, 'fix', { body: 'Fix submitted in E2E' });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify-fix', { body: 'Approved in E2E' }, { approve: true });

    await webLogin(page);
    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);

    await expect(page.getByText(/^CLOSED$/)).toBeVisible({ timeout: 4000 });
    await expect(page.getByRole('button', { name: 'Approve Fix' })).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: 'Verify' })).not.toBeVisible({ timeout: 3000 });
  });
});
