import type { Readable } from 'stream';
import { isLogStream, LogStreamName } from './domain/fleet-job-log.domain';

export const LOG_STORE = Symbol('LOG_STORE');

export type AppendResult =
  | { kind: 'appended'; size: number }
  | { kind: 'duplicate'; size: number } // offset + length <= size: these bytes are already stored
  | { kind: 'conflict'; size: number }; // a gap or a partial overlap

/**
 * Spec §1.1 (C6 split): append-only log bytes on disk; Postgres keeps only the FleetJobLog index row.
 * `append` and `replace` assume the caller holds `withLock(key)` (plan D311); they do not lock.
 */
export interface LogStore {
  append(key: string, offset: number, bytes: Buffer): Promise<AppendResult>;
  size(key: string): Promise<number>;
  read(key: string, from: number, to: number): Promise<Buffer>;
  stream(key: string): Promise<Readable>;
  replace(key: string, source: Readable, maxBytes: number): Promise<number>;
  deletePrefix(prefix: string): Promise<void>;
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Server-built key from validated parts only (spec §1.1). */
export function logKey(jobId: string, leaseEpoch: number, stream: LogStreamName): string {
  if (!ID_RE.test(jobId) || !Number.isInteger(leaseEpoch) || leaseEpoch < 0 || !isLogStream(stream)) {
    throw new Error(`invalid log key part: ${jobId}/${leaseEpoch}/${String(stream)}`);
  }
  return `logs/${jobId}/${leaseEpoch}/${stream}.log`;
}
