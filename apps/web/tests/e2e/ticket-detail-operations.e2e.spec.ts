import { test, expect } from '@playwright/test';
import {
  login,
  createProject,
  createTicket,
  deleteProject,
  transitionTicket,
  E2E_ADMIN,
} from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
const ASSIGN_REGEX = /^Assign$|^指派$/i;
const CLOSE_REGEX = /^Close$|^关闭$/i;
const DELETE_REGEX = /^Delete$|^删除$/i;
const DELETE_TICKET_REGEX = /Delete Ticket|删除工单/i;
const ADD_LINK_REGEX = /Add Link|添加链接/i;

async function createLabel(token: string, projectSlug: string, name: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, color: '#22C55E' }),
  });
  if (!res.ok) throw new Error(`Create label failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { data?: { id?: string; name?: string } };
  return { id: body.data?.id ?? '', name: body.data?.name ?? name };
}

async function assignLabelToTicket(token: string, projectSlug: string, ticketRef: string, labelId: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ labelId }),
  });
  if (!res.ok) throw new Error(`Assign label failed: ${res.status} ${await res.text()}`);
}

async function createTicketLink(token: string, projectSlug: string, ticketRef: string, url: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, linkType: 'url' }),
  });
  if (!res.ok) throw new Error(`Create ticket link failed: ${res.status} ${await res.text()}`);
}

async function createComment(token: string, projectSlug: string, ticketRef: string, commentBody: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ body: commentBody, type: 'GENERAL' }),
  });
  if (!res.ok) throw new Error(`Create comment failed: ${res.status} ${await res.text()}`);
}

test.describe('Ticket Detail Operations', () => {
  let token: string;
  let userId: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token, userId } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const proj = await createProject(token, {
      name: 'E2E Ticket Detail Operations',
      slug: `e2e-ticket-ops-${Date.now()}`,
      key: generateUniqueProjectKey('TD'),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test.beforeEach(async ({ page }) => {
    await webLogin(page);
  });

  test('sends assign, close, and delete ticket requests', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: `E2E Assign Close ${Date.now()}`, type: 'BUG' });
    await transitionTicket(token, projectSlug, ticket.ref, 'verify', { body: 'verify for close action visibility' });

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);
    await page.waitForLoadState('networkidle');
    const assigneeInput = page.getByPlaceholder(/User ID|用户 ID/i).first();
    await assigneeInput.fill(userId);
    await expect(assigneeInput).toHaveValue(userId);

    // Wait for the Assign button to become enabled after filling input
    const assignButton = page.locator('button', { hasText: ASSIGN_REGEX }).first();
    await expect(assignButton).toBeEnabled({ timeout: 5000 });

    const assignRequest = page.waitForRequest(request =>
      request.method() === 'POST' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}/assign`)
    );
    await assignButton.click();
    await expect(assignRequest).resolves.toBeTruthy();

    const closeRequest = page.waitForRequest(request =>
      request.method() === 'POST' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}/close`)
    );
    await page.getByRole('button', { name: CLOSE_REGEX }).first().click();
    await expect(closeRequest).resolves.toBeTruthy();

    page.once('dialog', dialog => dialog.accept());
    const deleteRequest = page.waitForRequest(request =>
      request.method() === 'DELETE' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}`)
    );
    await page.getByRole('button', { name: DELETE_TICKET_REGEX }).click();
    await expect(deleteRequest).resolves.toBeTruthy();
  });

  test('sends ticket label and link add/remove requests', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: `E2E Label Link ${Date.now()}`, type: 'BUG' });
    const label = await createLabel(token, projectSlug, `e2e-ticket-label-${Date.now()}`);
    await assignLabelToTicket(token, projectSlug, ticket.ref, label.id);
    await createTicketLink(token, projectSlug, ticket.ref, `https://example.com/remove/${Date.now()}`);

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);
    await page.waitForLoadState('networkidle');

    // Labels are rendered as Badge components - click the badge to send DELETE request
    const removeLabelRequest = page.waitForRequest(request =>
      request.method() === 'DELETE' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}/labels/${label.id}`)
    );
    await page.getByText(label.name, { exact: true }).first().click();
    await expect(removeLabelRequest).resolves.toBeTruthy();

    // Add a new link
    const addLinkUrl = `https://example.com/add/${Date.now()}`;
    await page.getByPlaceholder('https://...').fill(addLinkUrl);
    const addLinkRequest = page.waitForRequest(request =>
      request.method() === 'POST' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}/links`)
    );
    const addLinkButton = page.locator('button', { hasText: ADD_LINK_REGEX }).first();
    await expect(addLinkButton).toBeEnabled();
    await addLinkButton.click();
    await expect(addLinkRequest).resolves.toBeTruthy();

    // Remove the link
    const removableRow = page.locator('div.flex.items-center.justify-between.gap-2.text-sm', { hasText: 'example.com/remove' }).first();
    const removeLinkRequest = page.waitForRequest(request =>
      request.method() === 'DELETE' &&
      request.url().includes(`/api/projects/${projectSlug}/tickets/${ticket.ref}/links/`)
    );
    await removableRow.getByRole('button', { name: DELETE_REGEX }).click();
    await expect(removeLinkRequest).resolves.toBeTruthy();
  });

  test('sends DELETE /comments/:id from ticket detail', async ({ page }) => {
    const ticket = await createTicket(token, projectSlug, { title: `E2E Comment Delete ${Date.now()}`, type: 'BUG' });
    const commentBody = `e2e-comment-${Date.now()}`;
    await createComment(token, projectSlug, ticket.ref, commentBody);

    await page.goto(`/${projectSlug}/tickets/${ticket.ref}`);
    await page.waitForLoadState('networkidle');

    // Wait for comment to appear
    const commentDiv = page.locator('div.border.rounded-md', { hasText: commentBody }).first();
    await expect(commentDiv).toBeVisible({ timeout: 10000 });

    // Set up dialog handler before clicking
    page.once('dialog', dialog => dialog.accept());
    const deleteCommentRequest = page.waitForRequest(request =>
      request.method() === 'DELETE' && request.url().includes('/api/comments/')
    );
    await commentDiv.getByRole('button', { name: DELETE_REGEX }).click();
    await expect(deleteCommentRequest).resolves.toBeTruthy();
  });
});
