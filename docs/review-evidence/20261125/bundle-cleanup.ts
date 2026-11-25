// Exercise exception cleanup in the service with one tiny temporary file per case.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { BundleService } from '../../../apps/api/src/fleet/artifacts/bundle.service';
import { LocalDiskArtifactStore } from '../../../apps/api/src/fleet/artifacts/local-disk-artifact.store';
import { FenceService } from '../../../apps/api/src/fleet/sync/fence.service';

async function observe(failure: 'missing row' | 'database unavailable') {
  const root = await mkdtemp(join(tmpdir(), 'koda-bundle-cleanup-'));
  const job = { id: 'fixture', runnerId: 'worker', leaseEpoch: 1, state: 'UPLOADING' };
  let reads = 0;
  const repo = {
    lockById: async () => {
      if (++reads === 1) return job;
      if (failure === 'missing row') return null;
      throw new Error('fixture database unavailable');
    },
    upsertArtifact: () => assert.fail('fixture has no recordable job'),
  };
  const transaction = { run: <T>(work: () => Promise<T>) => work() };
  const store = new LocalDiskArtifactStore({ artifactDir: root });
  const service = new BundleService(repo as never, store, new FenceService(repo as never, undefined as never),
    undefined as never, transaction as never, { bundleMaxBytes: 1024 }, undefined as never, undefined as never,
    undefined as never, undefined as never);
  const data = gzipSync('fixture');
  try {
    await assert.rejects(service.upload({
      jobId: job.id, runnerId: job.runnerId, leaseEpochRaw: '1', body: Readable.from([data]),
      contentType: 'application/gzip', contentLength: String(data.length),
      sha256Header: createHash('sha256').update(data).digest('hex'),
    }), (err: Error) => failure === 'missing row' ? err.name === 'NotFoundAppException' :
      err.message === 'fixture database unavailable');
    const files = await readdir(join(root, 'jobs', job.id, '1'));
    assert.equal(reads, 2);
    assert.equal(files.length, failure === 'missing row' ? 0 : 1);
    if (files.length) assert.ok(files[0].endsWith('.tar.gz'));
    console.log(`06  ${failure}: artifact rows=0, durable files=${files.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  await observe('missing row');
  await observe('database unavailable');
}
void main();
