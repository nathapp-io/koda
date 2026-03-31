import { test, expect } from '@playwright/test';
import { createAgent, deleteAgent, login, updateAgentStatus, E2E_ADMIN } from './fixtures/api-client';
import { webLogin } from './fixtures/page-helpers';

test.describe('Agents', () => {
  let token: string;

  test.beforeAll(async () => {
    ({ token } = await login(E2E_ADMIN.email, E2E_ADMIN.password));
  });

  test('can create, read, update status, and delete an agent', async ({ page }) => {
    const suffix = Date.now().toString();
    const agentName = `E2E Agent ${suffix}`;
    const agentSlug = `e2e-agent-${suffix}`;
    let created = false;

    try {
      await createAgent(token, { name: agentName, slug: agentSlug });
      created = true;

      await webLogin(page);
      await page.goto('/agents');

      const agentRow = page.getByRole('row').filter({ hasText: agentSlug });
      await expect(agentRow).toBeVisible();
      await expect(agentRow).toContainText(agentName);
      await expect(agentRow).toContainText('ACTIVE');

      await updateAgentStatus(token, agentSlug, 'PAUSED');
      await page.reload();
      await expect(page.getByRole('row').filter({ hasText: agentSlug })).toContainText('PAUSED');

      await deleteAgent(token, agentSlug);
      await page.reload();
      await expect(page.getByRole('row').filter({ hasText: agentSlug })).toHaveCount(0);
      created = false;
    } finally {
      if (created) {
        await deleteAgent(token, agentSlug);
      }
    }
  });
});
