import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');

async function rootTest(args: string[], marker: string) {
  const child = Bun.spawn([process.execPath, 'run', 'test', ...args], {
    cwd: repoRoot,
    env: { ...process.env, NAX_SANDBOXED: marker, TURBO_TELEMETRY_DISABLED: '1' },
    stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
  return { stdout, stderr };
}

test('root test command delivers the sandbox marker to host-only tests', async () => {
  // Select only the receiver case: the nested root test must not run this test again.
  // Force execution so a cached skip cannot conceal a missing environment variable.
  const { stdout, stderr } = await rootTest([
    '--filter=@nathapp/koda-runner', '--force', '--env-mode=strict', '--output-logs=full',
    '--', '--test-name-pattern', 'binds 127\\.0\\.0\\.1',
  ], '1');
  expect(stdout + stderr).toMatch(/\(skip\).*binds 127\.0\.0\.1/);
  expect(stdout + stderr).not.toMatch(/\(pass\).*binds 127\.0\.0\.1/);
}, 25_000);

interface DryRun {
  globalCacheInputs: { files: Record<string, string> };
  tasks: Array<{
    taskId: string;
    hash: string;
    inputs: Record<string, string>;
    environmentVariables: { specified: { env: string[] } };
  }>;
}

function findTask(plan: DryRun, taskId: string): DryRun['tasks'][number] {
  const task = plan.tasks.find(task => task.taskId === taskId);
  if (!task) throw new Error(`Missing Turbo task: ${taskId}`);
  return task;
}

async function dryRun(marker: string): Promise<DryRun> {
  const { stdout } = await rootTest([
    '--filter=@nathapp/koda-api', '--filter=@nathapp/koda-runner',
    '--env-mode=strict', '--dry=json',
  ], marker);
  return JSON.parse(stdout) as DryRun;
}

test('Turbo hashes the sandbox marker for both consuming test tasks', async () => {
  const host = await dryRun('0');
  const sandbox = await dryRun('1');
  for (const packageName of ['@nathapp/koda-api', '@nathapp/koda-runner']) {
    const taskId = `${packageName}#test`;
    const hostTask = findTask(host, taskId);
    const sandboxTask = findTask(sandbox, taskId);
    expect(sandboxTask.environmentVariables.specified.env).toContain('NAX_SANDBOXED');
    expect(sandboxTask.hash).not.toBe(hostTask.hash);
  }
}, 25_000);

test('Turbo includes root test helpers without dropping workspace defaults', async () => {
  const plan = await dryRun('1');
  expect(plan.globalCacheInputs.files['test/helpers/test-environment.ts']).toBeString();
  for (const packageName of ['@nathapp/koda-api', '@nathapp/koda-runner']) {
    const task = findTask(plan, `${packageName}#test`);
    expect(task.inputs['package.json']).toBeString();
    expect(Object.keys(task.inputs).some(path => path.startsWith('src/'))).toBe(true);
  }
}, 25_000);
