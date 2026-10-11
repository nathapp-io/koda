import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { LocalDiskLogStore } from './local-disk-log.store';
import { logKey } from './log-store';

describe('LocalDiskLogStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-logs-'));
  const store = new LocalDiskLogStore({ artifactDir: root });
  const key = logKey('j1', 1, 'run');
  const b = (s: string) => Buffer.from(s);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('builds keys from validated parts', () => {
    expect(key).toBe('logs/j1/1/run.log');
    expect(() => logKey('../x', 1, 'run')).toThrow(/log key/);
    expect(() => logKey('j1', -1, 'run')).toThrow(/log key/);
  });

  it('appends only at the current size; answers duplicate and conflict with the size', async () => {
    await expect(store.size(key)).resolves.toBe(0);
    await expect(store.append(key, 0, b('abc\n'))).resolves.toEqual({ kind: 'appended', size: 4 });
    await expect(store.append(key, 0, b('abc\n'))).resolves.toEqual({ kind: 'duplicate', size: 4 });
    await expect(store.append(key, 2, b('c\n'))).resolves.toEqual({ kind: 'duplicate', size: 4 });
    await expect(store.append(key, 2, b('c\nde'))).resolves.toEqual({ kind: 'conflict', size: 4 });
    await expect(store.append(key, 9, b('x'))).resolves.toEqual({ kind: 'conflict', size: 4 });
    await expect(store.append(key, 4, b('de\n'))).resolves.toEqual({ kind: 'appended', size: 7 });
    expect(readFileSync(join(root, key), 'utf8')).toBe('abc\nde\n');
    await expect(store.read(key, 4, 100)).resolves.toEqual(b('de\n'));
  });

  it('serialises concurrent appends under withLock so the file is never interleaved', async () => {
    const k = logKey('j2', 1, 'stdout');
    const chunk = (i: number) => b(`line-${i}\n`);
    let offset = 0;
    const offsets = Array.from({ length: 20 }, (_, i) => { const o = offset; offset += chunk(i).length; return o; });
    const results = await Promise.all(offsets.map((o, i) => store.withLock(k, () => store.append(k, o, chunk(i)))));
    // Appends land in submission order because withLock is FIFO per key.
    expect(results.every((r) => r.kind === 'appended')).toBe(true);
    expect(readFileSync(join(root, k), 'utf8')).toBe(Array.from({ length: 20 }, (_, i) => `line-${i}\n`).join(''));
  });

  it('replace writes at most maxBytes, drains the rest of the source, and reports the bytes written', async () => {
    const k = logKey('j3', 1, 'stderr');
    await store.append(k, 0, b('old'));
    const written = await store.replace(k, Readable.from([b('0123456789'), b('abcdef')]), 12);
    expect(written).toBe(12);
    expect(readFileSync(join(root, k), 'utf8')).toBe('0123456789ab');
  });

  it('streams a whole object and deletes a prefix (absent prefix is a no-op)', async () => {
    const k = logKey('j4', 1, 'run');
    await store.append(k, 0, b('abc\nde\n'));
    const chunks: Buffer[] = [];
    for await (const c of await store.stream(k)) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('abc\nde\n');
    await store.deletePrefix('logs/j4/1/');
    expect(existsSync(join(root, 'logs/j4/1'))).toBe(false);
    await expect(store.deletePrefix('logs/nope/1/')).resolves.toBeUndefined();
    await expect(store.size(k)).resolves.toBe(0);
  });
});
