import { isNaxSandboxed } from '../helpers/test-environment';
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
    for (const word of ['enroll', 'run', 'status', 'vault', 'install-service', 'uninstall-service', '--home']) expect(stdout).toContain(word);
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
  test('vault enable points nax at this runner and exits 0; disable removes it; a config.json that is not JSON exits 1 and stays untouched', async () => {
    const dir = await tmp.make('cli');
    const home = join(dir, 'home');
    const naxHome = join(dir, 'naxhome');
    const configPath = join(naxHome, 'config.json');
    await mkdir(home, { recursive: true });
    await mkdir(naxHome, { recursive: true });
    await writeFile(join(home, 'runner.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:9', workspaceRoot: join(dir, 'ws'), naxHome }));
    const enable = await cli(['--home', home, 'vault', 'enable']);
    expect(enable.code).toBe(0);
    const written = JSON.parse(await readFile(configPath, 'utf8')) as { auth: { source: string; exec: { command: string[]; timeoutMs: number }; onChange: string } };
    expect(written.auth).toMatchObject({ source: 'exec', exec: { timeoutMs: 60_000 }, onChange: 'warn' });
    expect(written.auth.exec.command).toEqual([process.execPath, MAIN, 'provider-cred']);   // D84: how this runner runs again
    const disable = await cli(['--home', home, 'vault', 'disable']);
    expect(disable.code).toBe(0);
    expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({});
    await writeFile(configPath, '{ "agent": ');
    const invalid = await cli(['--home', home, 'vault', 'enable']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toMatch(/not valid JSON/);
    expect(await readFile(configPath, 'utf8')).toBe('{ "agent": ');
  });
  test('enroll without a token exits 1 and names the option and the environment variable', async () => {
    const home = join(await tmp.make('cli'), 'home');
    const { stderr, code } = await cli(['--home', home, 'enroll', '--server', 'https://koda.example.com'], { KODA_RUNNER_ENROLL_TOKEN: '' });
    expect(code).toBe(1);
    expect(stderr).toMatch(/--token|KODA_RUNNER_ENROLL_TOKEN/);
  });
  // The CI user name is always valid; a local one may not be, and a skipped test must say so rather than pass silently.
  // The nax sandbox withholds the host user-directory lookup used by install-service.
  test.skipIf(isNaxSandboxed() || !/^[a-z_][a-z0-9_-]{0,31}$/.test(process.env['USER'] ?? ''))('install-service --print shows the unit for this platform and changes nothing', async () => {
    const user = process.env['USER'] ?? '';
    const { stdout, code } = await cli(['--home', '/srv/koda-runner', 'install-service', '--user', user, '--print', '--path', '/usr/bin:/bin']);
    expect(code).toBe(0);
    expect(stdout).toContain(process.platform === 'darwin' ? '<key>AbandonProcessGroup</key>' : 'KillMode=process');
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
