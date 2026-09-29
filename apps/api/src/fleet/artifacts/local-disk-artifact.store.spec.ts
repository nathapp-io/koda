import { createHash } from 'crypto';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { ArtifactHashMismatchError, ArtifactTooLargeError } from './artifact-store';
import { LocalDiskArtifactStore } from './local-disk-artifact.store';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('LocalDiskArtifactStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'koda-artifacts-'));
  const store = new LocalDiskArtifactStore({ artifactDir: root });
  const good = Buffer.from('bundle-v1');

  it('stores, stats, reads and deletes', async () => {
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([good]), { maxBytes: 100, expectedSha256: sha(good) })).resolves.toEqual({ sizeBytes: good.length, sha256: sha(good) });
    expect(readFileSync(join(root, 'jobs/j1/1.tar.gz'))).toEqual(good);
    await expect(store.stat('jobs/j1/1.tar.gz')).resolves.toEqual({ sizeBytes: good.length });
    const chunks: Buffer[] = [];
    for await (const c of await store.get('jobs/j1/1.tar.gz')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(good);
  });

  it('keeps the previous file when a replacement is too large or has the wrong hash', async () => {
    const big = Buffer.alloc(200);
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([big]), { maxBytes: 100, expectedSha256: sha(big) })).rejects.toBeInstanceOf(ArtifactTooLargeError);
    await expect(store.put('jobs/j1/1.tar.gz', Readable.from([Buffer.from('x')]), { maxBytes: 100, expectedSha256: sha(good) })).rejects.toBeInstanceOf(ArtifactHashMismatchError);
    expect(readFileSync(join(root, 'jobs/j1/1.tar.gz'))).toEqual(good);
    await store.delete('jobs/j1/1.tar.gz');
    await expect(store.stat('jobs/j1/1.tar.gz')).resolves.toBeNull();
  });

  it.each(['../escape', '/abs/key', 'jobs/../x', 'jobs//x', 'jobs/x y'])('refuses key %s', async (key) => {
    await expect(store.stat(key)).rejects.toThrow(/artifact key/);
  });
});
