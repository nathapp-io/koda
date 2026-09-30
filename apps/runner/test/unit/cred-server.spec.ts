// apps/runner/test/unit/cred-server.spec.ts
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, stat, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { CredentialServer, type CredentialReply } from '../../src/credentials/cred-server';
import { MAX_SOCKET_PATH_BYTES, SocketDirError, defaultSocketDir, ensureSocketDir, socketPathFor } from '../../src/credentials/socket-dir';
import { makeTempDirs } from '../helpers/tmp';

const tmp = makeTempDirs();
afterAll(() => tmp.cleanup());
const uid = process.getuid?.() ?? 0;
const TOKEN: CredentialReply = { ok: true, username: 'x-access-token', token: 'ghs_t', expiresAt: '2099-01-01T00:00:00Z', protocol: 'https', host: 'github.com' };

/** A raw client: send `line`, collect everything until the server closes. */
function ask(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let out = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(line));
    socket.on('data', (chunk: string) => { out += chunk; });
    socket.on('end', () => resolve(out));
    socket.on('error', reject);
  });
}

describe('socket directory (D78)', () => {
  test('defaults to /tmp/koda-runner-<uid>', () => {
    expect(defaultSocketDir(501)).toBe('/tmp/koda-runner-501');
  });
  test('socket paths are 16 hex characters per (runner, job, epoch) and differ by each', () => {
    const a = socketPathFor('/s', 'r1', 'j1', 1);
    expect(a).toMatch(/^\/s\/[0-9a-f]{16}\.sock$/);
    expect(socketPathFor('/s', 'r1', 'j1', 1)).toBe(a);
    expect(socketPathFor('/s', 'r1', 'j1', 2)).not.toBe(a);
    expect(socketPathFor('/s', 'r2', 'j1', 1)).not.toBe(a);
  });
  test('an absent directory is created with mode 0700', async () => {
    const dir = join(await tmp.make('sd'), 'socks');
    await ensureSocketDir(dir, uid);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });
  test('Review focus 5: a group- or world-accessible directory is refused', async () => {
    const dir = join(await tmp.make('sd'), 'open');
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o755);
    await expect(ensureSocketDir(dir, uid)).rejects.toThrow(SocketDirError);
  });
  test('Review focus 5: a symlink is refused even when it points at a good directory', async () => {
    const base = await tmp.make('sd');
    const real = join(base, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(base, 'link'));
    await expect(ensureSocketDir(join(base, 'link'), uid)).rejects.toThrow(/not a link/);
  });
  test('a directory owned by another uid is refused', async () => {
    const dir = join(await tmp.make('sd'), 'mine');
    await ensureSocketDir(dir, uid);
    await expect(ensureSocketDir(dir, uid + 1)).rejects.toThrow(/owned by uid/);
  });
  test('a relative or too-long directory is refused', async () => {
    await expect(ensureSocketDir('socks', uid)).rejects.toThrow(/absolute/);
    const long = join(await tmp.make('sd'), 'x'.repeat(MAX_SOCKET_PATH_BYTES));
    await expect(ensureSocketDir(long, uid)).rejects.toThrow(/too long/);
  });
  test('a plain file at the path is refused', async () => {
    const file = join(await tmp.make('sd'), 'file');
    await writeFile(file, '');
    await expect(ensureSocketDir(file, uid)).rejects.toThrow(SocketDirError);
  });
  test('a plain file as a parent component is refused as a SocketDirError, not a raw ENOTDIR', async () => {
    const base = await tmp.make('sd');
    const file = join(base, 'file');
    await writeFile(file, '');
    await expect(ensureSocketDir(join(file, 'socks'), uid)).rejects.toThrow(SocketDirError);
  });
});

describe('CredentialServer (D79)', () => {
  const socketIn = async (): Promise<string> => join(await tmp.make('cs'), 'c.sock');

  test('answers `get` with one JSON line, and the socket file is mode 0600', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await server.close();
    }
  });
  test('any other line, or 64 bytes without a newline, is a bad request', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect(JSON.parse(await ask(path, 'store\n'))).toEqual({ ok: false, reason: 'bad request' });
      expect(JSON.parse(await ask(path, 'g'.repeat(65)))).toEqual({ ok: false, reason: 'bad request' });
      expect(JSON.parse(await ask(path, 'ß'.repeat(33)))).toEqual({ ok: false, reason: 'bad request' });   // 66 bytes, 33 chars
    } finally {
      await server.close();
    }
  });
  test('a provider that throws answers `error` and never leaks the message', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, async () => { throw new Error('ghs_secret in a message'); });
    try {
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual({ ok: false, reason: 'error' });
    } finally {
      await server.close();
    }
  });
  test('Review focus 3: a stale file at the path (a daemon that died) is replaced', async () => {
    const path = await socketIn();
    await writeFile(path, 'stale');
    const server = await CredentialServer.listen(path, async () => TOKEN);
    try {
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await server.close();
    }
  });
  test('close leaves alone a socket file that a newer server took over (a restarted daemon on the same path)', async () => {
    const path = await socketIn();
    const old = await CredentialServer.listen(path, async () => ({ ok: false, reason: 'old' }));
    const fresh = await CredentialServer.listen(path, async () => TOKEN);   // removes the old file, listens anew
    try {
      await old.close();
      expect(JSON.parse(await ask(path, 'get\n'))).toEqual(TOKEN);
    } finally {
      await fresh.close();
    }
  });
  test('close removes the socket file and does not wait for a reply that never comes', async () => {
    const path = await socketIn();
    const server = await CredentialServer.listen(path, () => new Promise<CredentialReply>(() => undefined));
    const pending = ask(path, 'get\n').catch(() => 'closed');
    await Bun.sleep(20);
    await server.close();
    expect(['', 'closed']).toContain(await pending);   // FIN or reset, depending on timing; never a reply
    await expect(stat(path)).rejects.toThrow();
  });
});
