import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, rm, stat } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { ArtifactHashMismatchError, ArtifactStore, ArtifactTooLargeError } from './artifact-store';

const KEY_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

@Injectable()
export class LocalDiskArtifactStore implements ArtifactStore {
  private readonly root: string;

  constructor(@Inject(FLEET_CFG) config: Pick<IFleetConfig, 'artifactDir'>) {
    this.root = resolve(config.artifactDir);
  }

  private pathFor(key: string): string {
    if (key.length > 256 || !KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`invalid artifact key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid artifact key: ${key}`);
    return full;
  }

  async put(key: string, source: Readable, opts: { maxBytes: number; expectedSha256: string }): Promise<{ sizeBytes: number; sha256: string }> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        if (size > opts.maxBytes) return done(new ArtifactTooLargeError());
        hash.update(chunk);
        return done(null, chunk);
      },
    });
    try {
      await pipeline(source, meter, createWriteStream(tmp, { mode: 0o600 }));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    const sha256 = hash.digest('hex');
    if (sha256 !== opts.expectedSha256.toLowerCase()) {
      await rm(tmp, { force: true });
      throw new ArtifactHashMismatchError();
    }
    try {
      await rename(tmp, target);
    } catch (error) {
      // Cross-device links, full disk, permission race, etc. The streaming body is gone;
      // the partial hash has not been committed anywhere. Clean up the tmp and rethrow
      // so BundleService.upload can surface the error and not record an artifact row.
      await rm(tmp, { force: true });
      throw error;
    }
    return { sizeBytes: size, sha256 };
  }

  async get(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path);
    return createReadStream(path);
  }

  async stat(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      return { sizeBytes: (await stat(this.pathFor(key))).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
