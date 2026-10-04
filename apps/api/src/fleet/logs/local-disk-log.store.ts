import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, open, rename, rm, stat } from 'fs/promises';
import { dirname, resolve, sep } from 'path';
import { Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { KeyedMutex } from './keyed-mutex';
import type { AppendResult, LogStore } from './log-store';

const KEY_RE = /^logs\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_.-]+)*\/?$/;

@Injectable()
export class LocalDiskLogStore implements LogStore {
  private readonly root: string;
  private readonly mutex = new KeyedMutex();

  constructor(@Inject(FLEET_CFG) config: Pick<IFleetConfig, 'artifactDir'>) {
    this.root = resolve(config.artifactDir);
  }

  private pathFor(key: string): string {
    if (key.length > 256 || !KEY_RE.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new Error(`invalid log key: ${key}`);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`invalid log key: ${key}`);
    return full;
  }

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(key, fn);
  }

  async size(key: string): Promise<number> {
    try {
      return (await stat(this.pathFor(key))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async append(key: string, offset: number, bytes: Buffer): Promise<AppendResult> {
    const size = await this.size(key);
    if (offset === size) {
      const path = this.pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { kind: 'appended', size: size + bytes.length };
    }
    if (offset + bytes.length <= size) return { kind: 'duplicate', size };
    return { kind: 'conflict', size };
  }

  async read(key: string, from: number, to: number): Promise<Buffer> {
    const size = await this.size(key);
    const end = Math.min(to, size);
    if (end <= from) return Buffer.alloc(0);
    const handle = await open(this.pathFor(key), 'r');
    try {
      const buffer = Buffer.alloc(end - from);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async stream(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path);
    return createReadStream(path);
  }

  async replace(key: string, source: Readable, maxBytes: number): Promise<number> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    const out = createWriteStream(tmp, { mode: 0o600 });
    let written = 0;
    let failure: Error | null = null;
    out.on('error', (error) => { failure = error; });
    // Writes up to maxBytes and keeps reading (and dropping) the rest, so a tar entry stream always drains.
    const capped = new Writable({
      write(chunk: Buffer, _enc, done) {
        const room = maxBytes - written;
        if (room <= 0) return done();
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        written += part.length;
        if (out.write(part)) return done();
        const onDrain = () => { out.off('error', onError); done(); };
        const onError = (error: Error) => { out.off('drain', onDrain); done(error); };
        out.once('drain', onDrain);
        out.once('error', onError);
        return undefined;
      },
      final(done) {
        out.end(() => done(failure));
      },
      destroy(error, done) {
        out.destroy();
        done(error);
      },
    });
    try {
      await pipeline(source, capped);
      await rename(tmp, target);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
    return written;
  }

  async deletePrefix(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix.replace(/\/$/, '')), { recursive: true, force: true });
  }
}
