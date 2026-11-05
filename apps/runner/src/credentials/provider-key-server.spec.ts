// apps/runner/src/credentials/provider-key-server.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNaxSandboxed } from '../../test/helpers/test-environment';
import { within } from '../../test/helpers/deadline';
import {
  CredentialServer, serveCredentialRequests, serveProviderRequests,
  type CredentialReply, type ProviderReply, type RequestSocket,
} from './cred-server';

const SOCKET: ProviderReply = { ok: true, key: 'sk-or-1', expiresAt: 1_760_000_000_000, account: 'koda:global:fleet' };

/** A stand-in for a client connection: the line protocol is what these tests are about, the socket is transport. */
class FakeSocket implements RequestSocket {
  private data: ((chunk: string) => void) | null = null;
  readonly written: string[] = [];
  setEncoding(): void {}
  on(event: 'error' | 'data', listener: (chunk: string) => void): this {
    if (event === 'data') this.data = listener;
    return this;
  }
  end(reply: string): this {
    this.written.push(reply);
    return this;
  }
  send(chunk: string): void {
    this.data?.(chunk);
  }
}

const settle = (): Promise<void> => Bun.sleep(1);

/**
 * What the socket wrote, parsed — with the raw text kept so an assertion names it. `null` means nothing was written
 * or it was not JSON, which a bare diff could not tell apart.
 */
function replyOf(written: readonly string[]): { reply: unknown; raw: string } {
  const raw = written.join('');
  try {
    return { reply: JSON.parse(raw), raw };
  } catch {
    return { reply: null, raw };
  }
}
const wrote = (written: readonly string[]): string => `the socket wrote ${JSON.stringify(written.join(''))}`;

describe('provider-key line protocol (US-008)', () => {
  test('AC-1: `provider openrouter` is answered with the provider reply as one JSON line', async () => {
    const socket = new FakeSocket();
    const asked: string[] = [];
    serveProviderRequests(socket, async (providerId) => { asked.push(providerId); return SOCKET; });
    socket.send('provider openrouter\n');
    await settle();
    expect(socket.written, wrote(socket.written))
      .toEqual(['{"ok":true,"key":"sk-or-1","expiresAt":1760000000000,"account":"koda:global:fleet"}\n']);
    expect(asked, `the reply was called with ${JSON.stringify(asked)}`).toEqual(['openrouter']);
  });

  test('AC-2: `provider Bad!` is a bad request and the provider reply is never called', async () => {
    const socket = new FakeSocket();
    let calls = 0;
    serveProviderRequests(socket, async () => { calls += 1; return SOCKET; });
    socket.send('provider Bad!\n');
    await settle();
    expect(replyOf(socket.written).reply, wrote(socket.written)).toEqual({ ok: false, reason: 'bad request' });
    expect(calls, `the provider reply was called ${calls} time(s) for a bad id`).toBe(0);
  });

  test('AC-3: `get` is a bad request on a provider-key socket', async () => {
    const socket = new FakeSocket();
    let calls = 0;
    serveProviderRequests(socket, async () => { calls += 1; return SOCKET; });
    socket.send('get\n');
    await settle();
    expect(replyOf(socket.written).reply, wrote(socket.written)).toEqual({ ok: false, reason: 'bad request' });
    expect(calls, `the provider reply was called ${calls} time(s) for a git request line`).toBe(0);
  });

  test('an id the pattern refuses, or no id at all, is a bad request', async () => {
    for (const line of ['provider\n', 'provider \n', `provider ${'a'.repeat(49)}\n`, 'provider a b\n', 'provider OpenRouter\n', 'provider /etc/passwd\n']) {
      const socket = new FakeSocket();
      let calls = 0;
      serveProviderRequests(socket, async () => { calls += 1; return SOCKET; });
      socket.send(line);
      await settle();
      const context = `line ${JSON.stringify(line)}: ${wrote(socket.written)}`;
      expect(replyOf(socket.written).reply, context).toEqual({ ok: false, reason: 'bad request' });
      expect(calls, `line ${JSON.stringify(line)}: the provider reply was called ${calls} time(s)`).toBe(0);
    }
  });

  test('a valid id of 48 characters is accepted', async () => {
    const socket = new FakeSocket();
    const asked: string[] = [];
    serveProviderRequests(socket, async (providerId) => { asked.push(providerId); return SOCKET; });
    const id = `a${'b'.repeat(47)}`;
    socket.send(`provider ${id}\n`);
    await settle();
    expect(asked, `the socket wrote ${JSON.stringify(socket.written.join(''))} for a 48-character id`).toEqual([id]);
  });

  test('a request delivered in two chunks is one line', async () => {
    const socket = new FakeSocket();
    serveProviderRequests(socket, async () => SOCKET);
    socket.send('provider open');
    await settle();
    expect(socket.written, `half a request line must not be answered: ${wrote(socket.written)}`).toEqual([]);
    socket.send('router\n');
    await settle();
    expect(replyOf(socket.written).reply, wrote(socket.written)).toEqual(SOCKET);
  });

  test('64 bytes without a newline is a bad request', async () => {
    const socket = new FakeSocket();
    serveProviderRequests(socket, async () => SOCKET);
    socket.send('x'.repeat(65));
    await settle();
    expect(replyOf(socket.written).reply, wrote(socket.written)).toEqual({ ok: false, reason: 'bad request' });
  });

  test('a provider reply that throws answers `error` and never leaks the message', async () => {
    const socket = new FakeSocket();
    serveProviderRequests(socket, async () => { throw new Error('sk-or-secret in a message'); });
    socket.send('provider openrouter\n');
    await settle();
    expect(replyOf(socket.written).reply, wrote(socket.written)).toEqual({ ok: false, reason: 'error' });
  });

  test('a provider-key socket answers only one line', async () => {
    const socket = new FakeSocket();
    let calls = 0;
    serveProviderRequests(socket, async () => { calls += 1; return SOCKET; });
    socket.send('provider openrouter\nprovider zai\n');
    await settle();
    expect(socket.written, wrote(socket.written)).toHaveLength(1);
    expect(calls, `two request lines answered ${calls} time(s)`).toBe(1);
  });

  test('AC-15: the git line protocol still answers `get` and still refuses `provider openrouter`', async () => {
    const token: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };
    const get = new FakeSocket();
    serveCredentialRequests(get, async () => token);
    get.send('get\n');
    await settle();
    expect(replyOf(get.written).reply, wrote(get.written)).toEqual(token);
    const provider = new FakeSocket();
    let calls = 0;
    serveCredentialRequests(provider, async () => { calls += 1; return token; });
    provider.send('provider openrouter\n');
    await settle();
    expect(replyOf(provider.written).reply, `${wrote(provider.written)} on a git credential socket`).toEqual({ ok: false, reason: 'bad request' });
    expect(calls, `a git credential socket answered the token ${calls} time(s) to a provider line`).toBe(0);
  });
});

/** A raw client: send `line`, collect everything until the server closes. Bounded: a silent socket must fail with a message. */
async function ask(path: string, line: string): Promise<string> {
  const answer = new Promise<string>((resolve, reject) => {
    const socket = createConnection(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', (error: Error) => reject(new Error(`${path} failed: ${error.message} (answered ${JSON.stringify(out)})`)));
  });
  return within(answer, `the answer from the socket at ${path}`);
}

/** The raw socket answer, parsed, with the text kept for the message (an empty answer means no line came back). */
async function answerOf(path: string, line: string): Promise<{ reply: unknown; raw: string }> {
  const raw = await ask(path, line);
  try {
    return { reply: JSON.parse(raw), raw };
  } catch {
    return { reply: null, raw };
  }
}

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

// The nax sandbox withholds real Unix socket binding (a socket path must also stay under 100 bytes, and $TMPDIR in a
// nax session is deep), so the real-socket half of these criteria runs on a host.
describe.skipIf(isNaxSandboxed())('CredentialServer.listenProviderKeys (US-008)', () => {
  const socketIn = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'pk-'));
    dirs.push(dir);
    return join(dir, 'p.sock');
  };

  test('AC-1: a provider-key socket answers `provider openrouter` with one JSON line, on a 0600 socket', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listenProviderKeys(path, async (providerId) => ({ ...SOCKET, key: `key-for-${providerId}` }));
    try {
      const mode = (await stat(path)).mode & 0o777;
      expect(mode, `socket ${path} has mode ${mode.toString(8)}`).toBe(0o600);
      const { reply, raw } = await answerOf(path, 'provider openrouter\n');
      expect(raw.endsWith('\n'), `the answer must be one line: ${JSON.stringify(raw)}`).toBe(true);
      expect(reply, `the socket answered ${JSON.stringify(raw)}`).toEqual({ ...SOCKET, key: 'key-for-openrouter' });
    } finally {
      await server.close();
    }
  });

  test('AC-2 and AC-3: a bad id and `get` are refused without asking for a key', async () => {
    const path = await socketIn();
    let calls = 0;
    const server = await CredentialServer.listenProviderKeys(path, async () => { calls += 1; return SOCKET; });
    try {
      const badId = await answerOf(path, 'provider Bad!\n');
      expect(badId.reply, `the socket answered ${JSON.stringify(badId.raw)} to a bad id`).toEqual({ ok: false, reason: 'bad request' });
      const git = await answerOf(path, 'get\n');
      expect(git.reply, `the socket answered ${JSON.stringify(git.raw)} to get`).toEqual({ ok: false, reason: 'bad request' });
      expect(calls, `the provider reply was called ${calls} time(s)`).toBe(0);
    } finally {
      await server.close();
    }
  });

  test('AC-15: CredentialServer.listen keeps the git protocol and still refuses a provider line', async () => {
    const token: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => token);
    try {
      const git = await answerOf(path, 'get\n');
      expect(git.reply, `the git socket answered ${JSON.stringify(git.raw)} to get`).toEqual(token);
      const provider = await answerOf(path, 'provider openrouter\n');
      expect(provider.reply, `the git socket answered ${JSON.stringify(provider.raw)} to a provider line`).toEqual({ ok: false, reason: 'bad request' });
    } finally {
      await server.close();
    }
  });

  test('a stale file left at the provider socket path is replaced', async () => {
    const path = await socketIn();
    await writeFile(path, 'stale');
    const server = await CredentialServer.listenProviderKeys(path, async () => SOCKET);
    try {
      const { reply, raw } = await answerOf(path, 'provider openrouter\n');
      expect(reply, `the socket answered ${JSON.stringify(raw)} after replacing a stale file`).toEqual(SOCKET);
    } finally {
      await server.close();
    }
  });

  test('close keeps the socket a newer server on the same path had already taken over', async () => {
    const path = await socketIn();
    const old = await CredentialServer.listenProviderKeys(path, async () => ({ ok: false, reason: 'none' }));
    const fresh = await CredentialServer.listenProviderKeys(path, async () => SOCKET);
    try {
      await old.close();
      const { reply, raw } = await answerOf(path, 'provider openrouter\n');
      expect(reply, `after the older server closed, the socket answered ${JSON.stringify(raw)}`).toEqual(SOCKET);
    } finally {
      await fresh.close();
    }
    await expect(stat(path), `${path} must be gone once its server closed`).rejects.toThrow();
  });

  test('close ends a reply that never comes', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listenProviderKeys(path, () => new Promise<ProviderReply>(() => undefined));
    const pending = ask(path, 'provider openrouter\n').catch(() => 'closed');
    await Bun.sleep(20);
    await server.close();
    const seen = await pending;
    expect(['', 'closed'], `a closed socket must not answer, but it sent ${JSON.stringify(seen)}`).toContain(seen);
  });
});
