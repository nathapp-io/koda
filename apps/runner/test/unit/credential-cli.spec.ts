import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { helperValue, writeShims } from '../../src/credentials/job-files';
import { installFakeGh } from '../helpers/fake-gh';
import { isolateGit } from '../helpers/git-fixture';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
beforeAll(() => isolateGit());
afterAll(() => tmp.cleanup());
const MAIN = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const SELF = [process.execPath, MAIN];
const REPLY: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_cli', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

async function run(argv: string[], opts: { stdin?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, ...opts.env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe('koda-runner git-cred through real git (design §3.1, D80, D84)', () => {
  test('`git credential fill` gets the job token for the job host', async () => {
    const sock = join(await tmp.make('cli'), 'c.sock');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      const out = await run(['git', '-c', 'credential.helper=', '-c', `credential.helper=${helperValue(SELF, sock)}`, 'credential', 'fill'], { stdin: 'protocol=https\nhost=github.com\n\n' });
      expect(out.code).toBe(0);
      expect(out.stdout).toContain('username=x-access-token\n');
      expect(out.stdout).toContain('password=ghs_cli\n');
    } finally {
      await server.close();
    }
  });
  test('Review focus 2: for another host git gets nothing and, with prompts disabled, fails', async () => {
    const sock = join(await tmp.make('cli'), 'c.sock');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      const out = await run(['git', '-c', 'credential.helper=', '-c', `credential.helper=${helperValue(SELF, sock)}`, 'credential', 'fill'], { stdin: 'protocol=https\nhost=evil.example\n\n', env: { GIT_ASKPASS: 'false' } });   // no askpass fallback from the shell
      expect(out.code).not.toBe(0);
      expect(out.stdout).not.toContain('ghs_cli');
    } finally {
      await server.close();
    }
  });
});

describe('koda-runner shim through a real shim script (D87)', () => {
  test('Review focus 4: gh gets the token, every argument byte for byte, a PATH without the shims; its exit code comes back', async () => {
    const dir = await tmp.make('cli');
    const sock = join(dir, 'c.sock');
    const binDir = join(dir, 'bin');
    const server = await CredentialServer.listen(sock, async () => REPLY);
    try {
      await writeShims(binDir, SELF, sock);
      const fake = await installFakeGh(dir);
      const title = `it's "$HOME" \`x\` a  b\nline two`;
      const out = await run([join(binDir, 'gh'), 'pr', 'create', '--title', title], {
        env: { PATH: [binDir, fake.binDir, process.env['PATH'] ?? ''].join(delimiter), FAKE_GH_LOG: fake.logPath, FAKE_GH_EXIT: '3' },
      });
      expect(out.code).toBe(3);
      expect(out.stdout.trim()).toBe('https://example.test/koda/pull/7');
      const [entry] = (await readFile(fake.logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(entry.argv).toEqual(['pr', 'create', '--title', title]);
      expect(entry.ghToken).toBe('ghs_cli');
      expect(entry.path.split(delimiter)).not.toContain(binDir);
    } finally {
      await server.close();
    }
  });
  test('with the socket gone gh still runs, without a token, and the shim warns once', async () => {
    const dir = await tmp.make('cli');
    const binDir = join(dir, 'bin');
    await writeShims(binDir, SELF, join(dir, 'gone.sock'));
    const fake = await installFakeGh(dir);
    const out = await run([join(binDir, 'gh'), '--version'], { env: { PATH: [binDir, fake.binDir, process.env['PATH'] ?? ''].join(delimiter), FAKE_GH_LOG: fake.logPath } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('gh version 0.0.0-fake');
    expect(out.stderr).toContain('no git token for this job (unavailable)');
    expect(JSON.parse((await readFile(fake.logPath, 'utf8')).trim()).ghToken).toBeNull();
  });
});
