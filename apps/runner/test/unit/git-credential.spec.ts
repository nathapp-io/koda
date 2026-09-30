// apps/runner/test/unit/git-credential.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { parseCredentialInput, parseReply, requestCredential, runGitCred, type GitCredIo } from '../../src/credentials/git-credential';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const REPLY: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

function io(stdin: string, reply: CredentialReply): GitCredIo & { out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  return { out, asked, readStdin: async () => stdin, write: (text) => { out.push(text); }, request: async (path) => { asked.push(path); return reply; } };
}
const input = (fields: Record<string, string>): string => `${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n\n`;

describe('parseCredentialInput', () => {
  test('reads key=value lines up to the blank line; a value may contain =', () => {
    expect(parseCredentialInput('protocol=https\nhost=github.com\npath=a=b\n\nignored=1\n')).toEqual({ protocol: 'https', host: 'github.com', path: 'a=b' });
  });
});

describe('runGitCred (D80)', () => {
  test('get for the job\'s own protocol and host prints username and password and exits 0', async () => {
    const x = io(input({ protocol: 'https', host: 'github.com' }), REPLY);
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out.join('')).toBe('username=x-access-token\npassword=ghs_t\n');
    expect(x.asked).toEqual(['/s.sock']);
  });
  test('Review focus 2: another host gets nothing, and the socket is still only asked once', async () => {
    const x = io(input({ protocol: 'https', host: 'gitlab.com' }), REPLY);
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual(['/s.sock']);   // the host is only known from the reply
  });
  test('the same host over another protocol gets nothing', async () => {
    const x = io(input({ protocol: 'http', host: 'github.com' }), REPLY);
    await runGitCred(['/s.sock', 'get'], x);
    expect(x.out).toEqual([]);
  });
  test.each(['store', 'erase'])('%s reads stdin, prints nothing, never asks the socket', async (action) => {
    const x = io(input({ protocol: 'https', host: 'github.com', password: 'p' }), REPLY);
    expect(await runGitCred(['/s.sock', action], x)).toBe(0);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual([]);
  });
  test('a refused reply prints nothing', async () => {
    const x = io(input({ protocol: 'https', host: 'github.com' }), { ok: false, reason: 'no token' });
    await runGitCred(['/s.sock', 'get'], x);
    expect(x.out).toEqual([]);
  });
  test('a token or username with a newline or NUL is never printed (it would inject credential lines)', async () => {
    for (const bad of [{ ...REPLY, token: 'a\nusername=evil' }, { ...REPLY, username: 'x\u0000' }]) {
      const x = io(input({ protocol: 'https', host: 'github.com' }), bad);
      await runGitCred(['/s.sock', 'get'], x);
      expect(x.out).toEqual([]);
    }
  });
  test('missing arguments exit 0 with nothing', async () => {
    const x = io('', REPLY);
    expect(await runGitCred([], x)).toBe(0);
    expect(x.out).toEqual([]);
  });
  test('a stdin read failure still exits 0 with nothing and never asks the socket (D80: always exit 0)', async () => {
    const out: string[] = [];
    const asked: string[] = [];
    const x: GitCredIo & { out: string[]; asked: string[] } = {
      out, asked,
      readStdin: async () => { throw new Error('stdin gone'); },
      write: (text) => { out.push(text); },
      request: async (path) => { asked.push(path); return REPLY; },
    };
    expect(await runGitCred(['/s.sock', 'get'], x)).toBe(0);
    expect(x.out).toEqual([]);
    expect(x.asked).toEqual([]);
  });
});

describe('requestCredential', () => {
  test('talks to a real CredentialServer', async () => {
    const path = join(await tmp.make('gc'), 'c.sock');
    const server = await CredentialServer.listen(path, async () => REPLY);
    try {
      expect(await requestCredential(path)).toEqual(REPLY);
    } finally {
      await server.close();
    }
  });
  test('a missing socket is `unavailable`', async () => {
    expect(await requestCredential(join(await tmp.make('gc'), 'none.sock'))).toEqual({ ok: false, reason: 'unavailable' });
  });
  test('a server that never answers is `timeout`', async () => {
    const path = join(await tmp.make('gc'), 'c.sock');
    const server = await CredentialServer.listen(path, () => new Promise<CredentialReply>(() => undefined));
    try {
      expect(await requestCredential(path, 50)).toEqual({ ok: false, reason: 'timeout' });
    } finally {
      await server.close();
    }
  });
  test('a reply over 16 KiB is `reply too large`', async () => {
    const path = join(await tmp.make('gc'), 'c.sock');
    const server = await CredentialServer.listen(path, async () => ({ ...REPLY, token: 'x'.repeat(20_000) }));
    try {
      expect(await requestCredential(path)).toEqual({ ok: false, reason: 'reply too large' });
    } finally {
      await server.close();
    }
  });
  test('parseReply refuses anything that is not exactly one of the two shapes', () => {
    expect(parseReply('not json')).toEqual({ ok: false, reason: 'bad reply' });
    expect(parseReply('{"ok":true,"token":"t"}')).toEqual({ ok: false, reason: 'bad reply' });
    expect(parseReply('{"ok":false,"reason":"job ended"}\n')).toEqual({ ok: false, reason: 'job ended' });
  });
});
