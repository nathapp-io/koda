import { test, expect } from '@playwright/test';
import { login, createProject, deleteProject, E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

function randomUppercase(length: number): string {
  return Array.from({ length }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
}

/**
 * KB (RAG) E2E tests.
 * Requires Ollama running locally with nomic-embed-text model pulled.
 * Skip these if SKIP_KB_E2E=1 is set.
 */
test.describe('Knowledge Base (KB)', () => {
  const skipKb = process.env['SKIP_KB_E2E'] === '1';

  let token: string;
  let projectSlug: string;

  test.beforeAll(async () => {
    if (skipKb) return;

    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));

    const suffix = Date.now().toString().slice(-6);
    const proj = await createProject(token, {
      name: 'E2E KB Project',
      slug: `e2e-kb-${suffix}`,
      key: randomUppercase(6),
    });
    projectSlug = proj.slug;
  });

  test.afterAll(async () => {
    if (!skipKb && projectSlug) await deleteProject(token, projectSlug);
  });

  test('can add a document to the KB via API', async () => {
    test.skip(skipKb, 'SKIP_KB_E2E=1');

    const res = await fetch(`${API_URL}/api/projects/${projectSlug}/kb/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        source: 'doc',
        sourceId: `e2e-kb-${Date.now()}`,
        content: 'The login endpoint uses JWT tokens for authentication. Tokens expire after 7 days.',
        metadata: { source: 'e2e-test', type: 'doc' },
      }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toBeDefined();
  });

  test('can list documents in the KB', async () => {
    test.skip(skipKb, 'SKIP_KB_E2E=1');

    const res = await fetch(`${API_URL}/api/projects/${projectSlug}/kb/documents`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  test('can search KB documents and get results', async () => {
    test.skip(skipKb, 'SKIP_KB_E2E=1');

    const res = await fetch(`${API_URL}/api/projects/${projectSlug}/kb/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: 'JWT token authentication', limit: 5 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.results).toBeDefined();
    expect(Array.isArray(body.data.results)).toBe(true);
  });

  test('KB page renders for a project', async ({ page }) => {
    test.skip(skipKb, 'SKIP_KB_E2E=1');

    await webLogin(page);

    await page.goto(`/${projectSlug}/kb`);
    await expect(page).toHaveURL(new RegExp(`${projectSlug}/kb`));
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });
});
