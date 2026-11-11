import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

describe('DB test project discovery', () => {
  it('selects every integration/e2e file once with bounded shared workers', () => {
    const root = resolve(__dirname, '..');
    // --filesOnly resolves the real config without importing tests or provisioning Postgres.
    const selected = JSON.parse(execFileSync(process.execPath, [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'list', 'test/integration', 'test/e2e', '--filesOnly', '--json',
    ], {
      cwd: root,
      env: { ...process.env, KODA_DB_TESTS: '1', NAX_SANDBOXED: '0' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    })) as { file: string; projectName: string }[];
    const expected = ['test/integration', 'test/e2e'].flatMap((dir) =>
      (readdirSync(resolve(root, dir), { recursive: true }) as string[])
        .filter((file) => file.endsWith('.spec.ts'))
        .map((file) => resolve(root, dir, file)),
    );
    expect(selected.map(({ file }) => file).sort()).toEqual(expected.sort());
    const shared = new Map<string, number>();
    for (const { projectName } of selected) {
      if (projectName.startsWith('db-shared')) {
        shared.set(projectName, (shared.get(projectName) ?? 0) + 1);
      }
    }
    expect(shared.size).toBeGreaterThan(1);
    expect(Math.max(...shared.values())).toBeLessThanOrEqual(25);
    expect(selected.find(({ file }) => file.endsWith('/approval-policy-writes.integration.spec.ts'))?.projectName)
      .toMatch(/^db-shared/);
    expect(selected.find(({ file }) => file.endsWith('/audit/audit-code-intel.integration.spec.ts'))?.projectName)
      .toBe('db-isolated');
  }, 30_000);
});
