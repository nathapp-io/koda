import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const FAKE_NAX = join(import.meta.dir, '..', 'fixtures', 'fake-nax.ts');

async function cli(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', MAIN, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('koda-runner CLI', () => {
  test('--version prints the package version', async () => {
    const { stdout, code } = await cli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
  test('--help lists enroll, run and status', async () => {
    const { stdout } = await cli(['--help']);
    for (const word of ['enroll', 'run', 'status', '--home']) expect(stdout).toContain(word);
  });
  test('status on an empty home says not enrolled and exits 0; --json is machine readable', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const text = await cli(['--home', home, 'status']);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/not enrolled/i);
    const json = await cli(['--home', home, 'status', '--json']);
    expect(JSON.parse(json.stdout)).toMatchObject({ enrolled: false });
  });
  test('run on an empty home exits 1 and tells the operator to enroll', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'run']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/enroll/);
  });
  test('enroll without a token exits 1 and names the option and the environment variable', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'https://koda.example.com'], { KODA_RUNNER_ENROLL_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/--token|KODA_RUNNER_ENROLL_TOKEN/);
  });
  test('an unreachable server on enroll is a readable error, not a stack trace', async () => {
    const dir = await tmp.make('cli');
    const home = join(dir, 'home');
    await mkdir(home, { recursive: true });
    // D95: enroll probes nax first; the fake nax stands in for it (CI machines have none).
    await writeFile(join(home, 'runner.json'), JSON.stringify({
      serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(dir, 'ws'), naxHome: join(dir, 'naxhome'), naxCommand: ['bun', FAKE_NAX],
    }));
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'http://127.0.0.1:9', '--token', 'ke_x']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/cannot reach the server/);
    expect(stderr).not.toMatch(/\n\s+at /);
  });
});
