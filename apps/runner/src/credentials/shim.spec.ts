// apps/runner/src/credentials/shim.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import type { CredentialReply } from './cred-server';
import { pathWithout, runShim, tokenEnv, type ShimDeps } from './shim';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());

const granted = (host: string): Extract<CredentialReply, { ok: true }> => ({ ok: true, username: 'x-access-token', token: 'ghs_s', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host });

function fake(reply: CredentialReply, over: Partial<ShimDeps> = {}) {
  const spawned: Array<{ argv: readonly string[]; env: Readonly<Record<string, string | undefined>> }> = [];
  const warnings: string[] = [];
  const handlers = new Map<string, () => void>();
  const killed: string[] = [];
  const asked: string[] = [];
  const deps: ShimDeps = {
    env: { PATH: '/job/bin:/usr/local/bin:/usr/bin', HOME: '/h' },
    request: async (path) => { asked.push(path); return reply; },
    which: (command, path) => (path.split(':').includes('/usr/local/bin') ? `/usr/local/bin/${command}` : null),
    spawn: (argv, env) => { spawned.push({ argv, env }); return { exited: Promise.resolve(3), kill: (signal) => { killed.push(signal); } }; },
    warn: (line) => { warnings.push(line); },
    onSignal: (signal, handler) => { handlers.set(signal, handler); },
    ...over,
  };
  return { deps, spawned, warnings, handlers, killed, asked };
}

describe('tokenEnv (D87)', () => {
  test('gh on github.com gets GH_TOKEN only; another host also gets GH_HOST and GH_ENTERPRISE_TOKEN', () => {
    expect(tokenEnv('gh', granted('github.com'))).toEqual({ GH_TOKEN: 'ghs_s' });
    expect(tokenEnv('gh', granted('ghe.corp:8443'))).toEqual({ GH_TOKEN: 'ghs_s', GH_ENTERPRISE_TOKEN: 'ghs_s', GH_HOST: 'ghe.corp:8443' });
  });
  test('glab on gitlab.com gets GITLAB_TOKEN only; another host also gets GITLAB_HOST', () => {
    expect(tokenEnv('glab', granted('gitlab.com'))).toEqual({ GITLAB_TOKEN: 'ghs_s' });
    expect(tokenEnv('glab', granted('git.corp'))).toEqual({ GITLAB_TOKEN: 'ghs_s', GITLAB_HOST: 'git.corp' });
  });
});

describe('pathWithout', () => {
  test('drops the shim dir however it is spelled, and empty entries', () => {
    expect(pathWithout('/job/bin::/usr/bin:/job/bin/:/job/./bin', '/job/bin')).toBe('/usr/bin');
  });
  test('drops a symlink alias of the shim dir too, so the shim cannot re-exec itself', async () => {
    const base = await tmp.make('pw');
    const bin = join(base, 'bin');
    await mkdir(bin, { recursive: true });
    await symlink(bin, join(base, 'alias'));
    const path = [bin, join(base, 'alias'), base, '/usr/bin'].join(delimiter);
    expect(pathWithout(path, bin)).toBe([base, '/usr/bin'].join(delimiter));
  });
});

describe('runShim (D87)', () => {
  test('runs the real gh with the token, the arguments verbatim, and PATH without the shim dir; returns its exit code', async () => {
    const f = fake(granted('github.com'));
    const code = await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'create', '--title', "it's $HOME"], f.deps);
    expect(code).toBe(3);
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0].argv).toEqual(['/usr/local/bin/gh', 'pr', 'create', '--title', "it's $HOME"]);
    expect(f.spawned[0].env).toMatchObject({ GH_TOKEN: 'ghs_s', PATH: '/usr/local/bin:/usr/bin', HOME: '/h' });
    expect(f.asked).toEqual(['/s.sock']);
  });
  test('without a token the real binary still runs, with no token variable and one warning', async () => {
    const f = fake({ ok: false, reason: 'no token' });
    await runShim(['glab', '/s.sock', '/job/bin', '--', '--version'], f.deps);
    expect(f.spawned[0].env['GITLAB_TOKEN']).toBeUndefined();
    expect(f.warnings).toEqual(['koda-runner: no git token for this job (no token); running glab without one']);
  });
  test('no real binary on PATH exits 127 and never asks the socket', async () => {
    const f = fake(granted('github.com'), { which: () => null });
    expect(await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'view'], f.deps)).toBe(127);
    expect(f.warnings).toEqual(['koda-runner: gh not found on PATH']);
    expect(f.asked).toEqual([]);
    expect(f.spawned).toEqual([]);
  });
  test.each([
    [['hub', '/s', '/b', '--']],
    [['gh', '/s', '/b', 'pr']],
    [['gh']],
  ])('bad usage %j exits 2', async (args) => {
    const f = fake(granted('github.com'));
    expect(await runShim(args, f.deps)).toBe(2);
    expect(f.spawned).toEqual([]);
  });
  test('SIGINT, SIGTERM and SIGHUP are forwarded to the child', async () => {
    const f = fake(granted('github.com'));
    await runShim(['gh', '/s.sock', '/job/bin', '--', 'pr', 'create'], f.deps);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) f.handlers.get(signal)?.();
    expect(f.killed).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  });
});
