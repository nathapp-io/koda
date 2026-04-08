import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin, generateUniqueProjectKey } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';
async function createKbDoc(token: string, projectSlug: string, sourceId: string) {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/kb/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      source: 'doc',
      sourceId,
      content: `KB content for ${sourceId}`,
      metadata: { source: 'playwright-e2e' },
    }),
  });
  if (!res.ok) throw new Error(`Create KB document failed: ${res.status} ${await res.text()}`);
}

test.describe('KB Admin Operations', () => {
  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
    const proj = await createProject(token, {
      name: 'E2E KB Admin Operations',
      slug: `e2e-kb-admin-${Date.now()}`,
      key: generateUniqueProjectKey('KB'),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (projectSlug) await deleteProject(token, projectSlug);
  });

  test.beforeEach(async ({ page }) => {
    await webLogin(page);
  });

  test('sends KB optimize and delete source requests', async ({ page }) => {
    const sourceId = `e2e-kb-source-${Date.now()}`;
    await createKbDoc(token, projectSlug, sourceId);

    await page.goto(`/${projectSlug}/kb`);

    const optimizeResponse = await page.request.post(`${API_URL}/api/projects/${projectSlug}/kb/optimize`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(optimizeResponse.ok()).toBeTruthy();

    const deleteResponse = await page.request.delete(`${API_URL}/api/projects/${projectSlug}/kb/documents/${sourceId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(deleteResponse.ok()).toBeTruthy();
  });
});
