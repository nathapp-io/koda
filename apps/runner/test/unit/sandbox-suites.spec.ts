import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

test('sandbox-marked host suites skip while pure tests in mixed files still execute', async () => {
  const child = Bun.spawn([
    process.execPath, 'test',
    'src/approvals/nax-callback.spec.ts',
    'test/unit/cred-server.spec.ts',
    'test/integration/process-info.integration.spec.ts',
  ], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, NAX_SANDBOXED: '1', KODA_DB_TESTS: '1' },
    stdout: 'pipe', stderr: 'pipe',
    timeout: 15_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  const output = stdout + stderr;
  expect(code, output).toBe(0);
  expect(output).toMatch(/\(skip\) readProcessCommand/);
  expect(output).toMatch(/\(skip\) CredentialServer/);
  expect(output).toMatch(/\(pass\) signing/);
  expect(output).toMatch(/\(pass\) socket directory/);
  expect(output).toMatch(/\(pass\) reapNaxPids.*no registry file/);
}, 20_000);
