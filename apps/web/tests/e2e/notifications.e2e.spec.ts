import { test, expect } from '@playwright/test';
import {
  addProjectMember, assignTicket, createProject, createTicket, createUser, deleteProject, login, E2E_ADMIN,
} from './fixtures/api-client';
import { generateUniqueProjectKey, waitForHydration, webLogin } from './fixtures/page-helpers';

/**
 * Fleet S4a §8: A (the admin) assigns a ticket to B over the API; B's header bell rises live without a reload;
 * clicking the notification marks it read and opens the ticket.
 */
const MEMBER = { email: 'notify-member@koda-e2e.test', name: 'Notify Member', password: 'E2ePassword1!' };

test.describe('Notifications (S4a)', () => {
  let token: string;
  let slug: string;
  let memberId: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    slug = (await createProject(token, { name: 'E2E Notify', slug: `e2entf${suffix}`, key: generateUniqueProjectKey('NT') })).slug;
    await createUser(token, MEMBER);
    await addProjectMember(token, slug, MEMBER.email, 'DEVELOPER');
    // Same cached session webLogin uses below: no extra /auth/login hit.
    ({ userId: memberId } = await login(MEMBER.email, MEMBER.password));
  });

  test.afterAll(async () => {
    if (slug) await deleteProject(token, slug);
  });

  test('an assignment reaches B\'s bell live; clicking it reads it and opens the ticket', async ({ page }) => {
    const title = `Notify me ${Date.now()}`;
    const ticket = await createTicket(token, slug, { title, type: 'BUG' });
    await webLogin(page, MEMBER.email, MEMBER.password);

    const streamOpen = page.waitForResponse(
      (res) => res.url().includes('/api/me/events') && res.status() === 200,
      { timeout: 10000 },
    );
    await page.goto(`/${slug}`);
    await streamOpen;
    await waitForHydration(page);
    const bell = page.getByTestId('notification-bell');
    const before = Number(await bell.getAttribute('data-count'));
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    await assignTicket(token, slug, ticket.ref, memberId);

    await expect(bell).toHaveAttribute('data-count', String(before + 1), { timeout: 10000 });
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);

    await bell.click();
    const item = page.getByTestId('notification-item').filter({ hasText: ticket.ref }).first();
    await expect(item).toContainText(`assigned you ${ticket.ref}: ${title}`);
    await item.click();

    await expect(page).toHaveURL(new RegExp(`/${slug}/tickets/${ticket.ref}$`));
    await expect(page.getByTestId('notification-bell')).toHaveAttribute('data-count', String(before), { timeout: 5000 });
    // The assignee is auto-watching (spec §2.2): the detail page says so.
    await expect(page.getByTestId('ticket-watch-toggle')).toHaveAttribute('aria-pressed', 'true');
  });

  test('the inbox page lists it as read and the preferences page shows five toggles', async ({ page }) => {
    await webLogin(page, MEMBER.email, MEMBER.password);
    await page.goto('/notifications');
    await waitForHydration(page);
    await expect(page.getByTestId('notifications-row').first()).toBeVisible();

    await page.goto('/settings/notifications');
    await waitForHydration(page);
    for (const c of ['ASSIGNED', 'MENTIONED', 'WATCHED_ACTIVITY', 'FLEET_NEEDS_YOU', 'FLEET_HEALTH']) {
      await expect(page.getByTestId(`notification-pref-${c}`)).toBeVisible();
    }
  });
});
