import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { makeTempDirs } from '../../test/helpers/tmp';
import { enableVault, runVaultCommand, vaultHelperCommand, vaultHelperEnabled, type VaultFs } from './vault';

/** D84: what a compiled binary and a source checkout each put first; both are the operator's runner. */
const SELF = ['/opt/koda/bin/koda-runner', '/opt/koda/apps/runner/src/main.ts'];
const HELPER = [...SELF, 'provider-cred'];
const AUTH = { source: 'exec', exec: { command: HELPER, timeoutMs: 60_000 }, onChange: 'warn' };

const tmp = makeTempDirs();
afterEach(() => tmp.cleanup());

interface Home {
  /** is the runner home `--home` names. */
  readonly home: string;
  /** is the nax global config dir runner.json names. */
  readonly naxHome: string;
  readonly configPath: string;
}

/** A runner home whose runner.json names `naxHome`; the operator enrolled as `resolveHome` would. */
async function makeHome(): Promise<Home> {
  const dir = await tmp.make('vault');
  const home = join(dir, 'home');
  const naxHome = join(dir, 'naxhome');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'runner.json'), JSON.stringify({ serverUrl: 'https://koda.example.com', workspaceRoot: join(dir, 'ws'), naxHome }));
  return { home, naxHome, configPath: join(naxHome, 'config.json') };
}

/** `koda-runner vault <action>` with its output captured, so a test reads what an operator would see. */
function vaultCommand(home: Home, self: readonly string[] = SELF) {
  const said: string[] = [];
  const warned: string[] = [];
  return {
    said,
    warned,
    run: (action: 'enable' | 'disable') => runVaultCommand(action, home.home, {
      env: {} as NodeJS.ProcessEnv, self, say: (line) => said.push(line), warn: (line) => warned.push(line),
    }),
  };
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

describe('vault helper command (US-010)', () => {
  test('AC-1: enable keeps every other key and adds koda\'s exec auth block', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, JSON.stringify({ agent: { x: 1 } }));
    const c = vaultCommand(h);
    expect(await c.run('enable')).toBe(0);
    expect(await readJson(h.configPath)).toEqual({ agent: { x: 1 }, auth: AUTH });
    expect(c.warned).toEqual([]);
    expect(c.said.join('\n')).toContain(h.configPath);
  });

  test('AC-1: a second enable changes nothing, and the block it wrote is the one nax reads', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, JSON.stringify({ agent: { x: 1 } }));
    await enableVault(h.naxHome, SELF);
    const once = await readFile(h.configPath, 'utf8');
    await enableVault(h.naxHome, SELF);
    expect(await readFile(h.configPath, 'utf8')).toBe(once);
    expect(vaultHelperCommand(SELF)).toEqual(HELPER);
  });

  test('AC-2: enable with no config.json creates one holding only the auth block', async () => {
    const h = await makeHome();
    expect(await stat(h.naxHome).catch(() => null)).toBeNull();   // neither the file nor its directory exists
    expect(await vaultCommand(h).run('enable')).toBe(0);
    expect(await readJson(h.configPath)).toEqual({ auth: AUTH });
    expect(await readdir(h.naxHome)).toEqual(['config.json']);
  });

  test('AC-3: enable stages a file in the same directory and renames it onto config.json', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, JSON.stringify({ agent: { x: 1 } }));
    const before = await stat(h.configPath);
    const renames: Array<{ from: string; to: string }> = [];
    const fs: VaultFs = {
      rename: async (from, to) => {
        renames.push({ from: String(from), to: String(to) });
        await rename(from, to);
      },
    };
    await enableVault(h.naxHome, SELF, fs);
    expect(renames).toHaveLength(1);
    const [renamed] = renames;
    expect(renamed?.to).toBe(h.configPath);
    expect(renamed === undefined ? null : dirname(renamed.from)).toBe(h.naxHome);   // same directory, so the rename is atomic
    expect(renamed?.from).not.toBe(renamed?.to);
    expect((await stat(h.configPath)).ino).not.toBe(before.ino);   // replaced by a rename, never written in place
    expect(await readdir(h.naxHome)).toEqual(['config.json']);   // and the staging file is not left behind
  });

  test('AC-4: enable on a config.json that is not valid JSON exits non-zero and leaves it byte-identical', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    const invalid = '{ "agent": { "x": 1 },';
    await writeFile(h.configPath, invalid);
    const c = vaultCommand(h);
    expect(await c.run('enable')).toBe(1);
    expect(await readFile(h.configPath, 'utf8')).toBe(invalid);
    expect(c.warned.join('\n')).toMatch(/not valid JSON/);
    expect(await readdir(h.naxHome)).toEqual(['config.json']);
  });

  test('AC-5: disable removes auth and keeps every other key', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, JSON.stringify({ agent: { x: 1 }, auth: AUTH, models: { native: { fast: 'a/b' } } }));
    expect(await vaultCommand(h).run('disable')).toBe(0);
    expect(await readJson(h.configPath)).toEqual({ agent: { x: 1 }, models: { native: { fast: 'a/b' } } });
  });

  test('AC-5: disable on a file with no auth, or with no config.json at all, changes nothing', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    const withoutAuth = '{"agent":{"x":1}}\n';
    await writeFile(h.configPath, withoutAuth);
    expect(await vaultCommand(h).run('disable')).toBe(0);
    expect(await readFile(h.configPath, 'utf8')).toBe(withoutAuth);
    const bare = await makeHome();
    expect(await vaultCommand(bare).run('disable')).toBe(0);
    expect(await stat(bare.configPath).catch(() => null)).toBeNull();
  });

  test('AC-5: disable on invalid JSON refuses like enable does', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, 'not json at all');
    const c = vaultCommand(h);
    expect(await c.run('disable')).toBe(1);
    expect(await readFile(h.configPath, 'utf8')).toBe('not json at all');
  });

  test('a runner home with no runner.json is a readable failure, not a stack trace', async () => {
    const dir = await tmp.make('vault-empty');
    const c = {
      warned: [] as string[],
      run: () => runVaultCommand('enable', join(dir, 'home'), { env: {} as NodeJS.ProcessEnv, self: SELF, say: () => undefined, warn: (line: string) => c.warned.push(line) }),
    };
    expect(await c.run()).toBe(1);
    expect(c.warned.join('\n')).toMatch(/enroll/);
  });

  test('AC-6: the helper is koda\'s exactly when auth.exec.command is [...self argv, provider-cred]', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, JSON.stringify({ auth: AUTH }));
    expect(await vaultHelperEnabled(h.naxHome, SELF)).toBe(true);
  });

  test('AC-6: what enable writes for another install is what that install detects', async () => {
    const h = await makeHome();
    const other = ['/srv/koda-runner/koda-runner'];
    await enableVault(h.naxHome, other);
    expect(await vaultHelperEnabled(h.naxHome, other)).toBe(true);
    expect(await vaultHelperEnabled(h.naxHome, SELF)).toBe(false);
  });

  test('AC-7: another helper, another subcommand, a longer argv or no config.json is not koda\'s', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    const others: unknown[] = [
      { auth: { source: 'exec', exec: { command: ['/usr/local/bin/nax-vault-helper'], timeoutMs: 60_000 }, onChange: 'warn' } },
      { auth: { source: 'exec', exec: { command: [...SELF, 'shim'], timeoutMs: 60_000 }, onChange: 'warn' } },
      { auth: { source: 'exec', exec: { command: [...HELPER, '--socket', '/tmp/p.sock'], timeoutMs: 60_000 }, onChange: 'warn' } },
      { auth: { source: 'exec', exec: { command: SELF, timeoutMs: 60_000 }, onChange: 'warn' } },
      { auth: { source: 'exec' } },
      { auth: { source: 'file' } },
      { auth: null },
      {},
    ];
    for (const config of others) {
      await writeFile(h.configPath, JSON.stringify(config));
      expect(await vaultHelperEnabled(h.naxHome, SELF)).toBe(false);
    }
    const bare = await makeHome();
    expect(await vaultHelperEnabled(bare.naxHome, SELF)).toBe(false);
  });

  test('AC-7: an unreadable config.json is a refusal, not a "no helper" claim', async () => {
    const h = await makeHome();
    await mkdir(h.naxHome, { recursive: true });
    await writeFile(h.configPath, '{ not json');
    await expect(vaultHelperEnabled(h.naxHome, SELF)).rejects.toThrow(/not valid JSON/);
  });
});
