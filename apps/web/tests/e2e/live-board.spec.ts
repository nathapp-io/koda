import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  addProjectMember,
  createComment,
  createProject,
  createTicket,
  createUser,
  deleteProject,
  deleteTicket,
  login,
  transitionTicket,
  E2E_ADMIN,
} from './fixtures/api-client';
import { generateUniqueProjectKey, webLogin } from './fixtures/page-helpers';


/**
 * Track 1 Slice 5 proof: live updates stream through the real Nuxt proxy.
 * A (admin) and B (a project DEVELOPER) use separate browser contexts.
 */
const MEMBER = { email: 'live-member@koda-e2e.test', name: 'Live Member', password: 'E2ePassword1!' };

interface Session {
  context: BrowserContext;
  page: Page;
}

async function openAs(browser: Browser, email: string, password: string): Promise<Session> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await webLogin(page, email, password);
  return { context, page };
}

/** Navigate and resolve once this page's live stream answered 200. */
async function gotoLive(page: Page, url: string, slug: string): Promise<void> {
  const streamOpen = page.waitForResponse(
    (res) => res.url().includes(`/api/projects/${slug}/events`) && res.status() === 200,
    { timeout: 10000 },
  );
  await page.goto(url);
  await streamOpen;
}

test.describe('Live updates (SSE through the Nuxt proxy)', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const suffix = Date.now().toString().slice(-6);
    const project = await createProject(token, {
      name: 'E2E Live Board',
      slug: `e2elive${suffix}`,
      key: generateUniqueProjectKey('LV'),
    });
    projectSlug = project.slug;
    await createUser(token, MEMBER);
    await addProjectMember(token, projectSlug, MEMBER.email, 'DEVELOPER');
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test('A verifies a ticket; the card moves on B\'s board without a reload', async ({ browser }) => {
    // createTicket returns { id, ref, status } only: keep the title locally.
    const title = `Live move ${Date.now()}`;
    const ticket = await createTicket(token, projectSlug, { title, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      await gotoLive(b.page, `/${projectSlug}`, projectSlug);
      await expect(b.page.getByTestId('board-column-CREATED').getByText(title)).toBeVisible();
      await b.page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

      // A (the admin) verifies via the API, exactly like ticket-lifecycle.spec.ts:
      // the ticket detail transition dialog silently drops its comment (the shared
      // ui/textarea never syncs v-model), so the dialog path 400s outside this slice.
      await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'verified while B watches' });

      await expect(b.page.getByTestId('board-column-VERIFIED').getByText(title)).toBeVisible({ timeout: 5000 });
      expect(await b.page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    }
    finally {
      await b.context.close();
    }
  });

  test('B on ticket detail sees a new comment appear', async ({ browser }) => {
    const ticket = await createTicket(token, projectSlug, { title: `Live comment ${Date.now()}`, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      await gotoLive(b.page, `/${projectSlug}/tickets/${ticket.ref}`, projectSlug);
      const body = `live comment ${Date.now()}`;

      await createComment(token, projectSlug, ticket.ref, body);

      await expect(b.page.getByText(body)).toBeVisible({ timeout: 5000 });
    }
    finally {
      await b.context.close();
    }
  });

  test('leaving the board releases the stream: after 6 visits live updates still arrive', async ({ browser }) => {
    const title = `Live leak ${Date.now()}`;
    const ticket = await createTicket(token, projectSlug, { title, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      for (let visit = 0; visit < 6; visit += 1) {
        await gotoLive(b.page, `/${projectSlug}`, projectSlug);
        await b.page.goto('/');
      }
      await gotoLive(b.page, `/${projectSlug}`, projectSlug);

      await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'verified after many visits' });

      await expect(b.page.getByTestId('board-column-VERIFIED').getByText(title)).toBeVisible({ timeout: 5000 });
    }
    finally {
      await b.context.close();
    }
  });

  test('B on ticket detail sees a deletion notice instead of an error', async ({ browser }) => {
    const ticket = await createTicket(token, projectSlug, { title: `Live delete ${Date.now()}`, type: 'BUG' });
    const b = await openAs(browser, MEMBER.email, MEMBER.password);
    try {
      await gotoLive(b.page, `/${projectSlug}/tickets/${ticket.ref}`, projectSlug);

      await deleteTicket(token, projectSlug, ticket.ref);

      await expect(b.page.getByTestId('ticket-deleted-notice')).toBeVisible({ timeout: 5000 });
    }
    finally {
      await b.context.close();
    }
  });
});
