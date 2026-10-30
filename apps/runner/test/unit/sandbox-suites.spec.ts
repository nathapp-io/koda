import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

test('sandbox-marked host suites skip while pure tests in mixed files still execute', async () => {
  const junitPath = join(import.meta.dir, `sandbox-suites-${randomUUID()}.xml`);
  const child = Bun.spawn([
    process.execPath, 'test', '--reporter=junit', `--reporter-outfile=${junitPath}`,
    'src/approvals/nax-callback.spec.ts',
    'src/approvals/approval-relay.spec.ts',
    'test/unit/cred-server.spec.ts',
    'test/integration/process-info.integration.spec.ts',
  ], {
    cwd: join(import.meta.dir, '../..'),
    env: { ...process.env, NAX_SANDBOXED: '1', KODA_DB_TESTS: '1' },
    stdout: 'pipe', stderr: 'pipe',
    timeout: 15_000,
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    const output = stdout + stderr;
    const report = await readFile(junitPath, 'utf8');
    expect(code, output).toBe(0);

    const cases = [...report.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)];
    const resultFor = (pattern: RegExp): 'passed' | 'skipped' | 'missing' => {
      const found = cases.find(([, attributes]) => {
        const name = attributes.match(/\bname="([^"]*)"/)?.[1] ?? '';
        const suite = attributes.match(/\bclassname="([^"]*)"/)?.[1] ?? '';
        return pattern.test(`${suite} ${name}`);
      });
      if (!found) return 'missing';
      return found[2]?.includes('<skipped') ? 'skipped' : 'passed';
    };

    expect(resultFor(/readProcessCommand/)).toBe('skipped');
    expect(resultFor(/CredentialServer/)).toBe('skipped');
    expect(resultFor(/ApprovalRelay journal.*an unknown ask/)).toBe('passed');
    expect(resultFor(/ApprovalRelay journal.*a malformed answer/)).toBe('passed');
    expect(resultFor(/ApprovalRelay journal.*sweepOrphans/)).toBe('passed');
    expect(resultFor(/signing/)).toBe('passed');
    expect(resultFor(/socket directory/)).toBe('passed');
    expect(resultFor(/reapNaxPids.*no registry file/)).toBe('passed');
  } finally {
    await rm(junitPath, { force: true });
  }
}, 20_000);
