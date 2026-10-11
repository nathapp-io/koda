// apps/runner/src/credentials/socket-dir.ts
import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export class SocketDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketDirError';
  }
}

/** Under the 104-byte `sun_path` of macOS (108 on Linux), with room to spare (D78). */
export const MAX_SOCKET_PATH_BYTES = 100;

export function defaultSocketDir(uid: number): string {
  return `/tmp/koda-runner-${uid}`;
}

/** D78: one socket per (runner, job, epoch); the runner id keeps two daemons of one uid apart. */
export function socketPathFor(dir: string, runnerId: string, jobId: string, leaseEpoch: number): string {
  const key = createHash('sha256').update(`${runnerId}:${jobId}:${leaseEpoch}`).digest('hex').slice(0, 16);
  return join(dir, `${key}.sock`);
}

/**
 * D78: created 0700 when absent. An existing one must be a real directory (not a link) owned by `uid` with no group or
 * other permission bit: a directory another user planted, or one they can list or write, could capture a token.
 */
export async function ensureSocketDir(dir: string, uid: number): Promise<void> {
  if (!isAbsolute(dir)) throw new SocketDirError('socketDir must be an absolute path');
  if (Buffer.byteLength(socketPathFor(dir, 'r', 'j', 1)) > MAX_SOCKET_PATH_BYTES) {
    throw new SocketDirError(`socketDir ${dir} is too long for a unix socket path (at most ${MAX_SOCKET_PATH_BYTES} bytes with the socket name)`);
  }
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST' && error.code !== 'ENOTDIR') throw error;
  });
  // A parent component that is a plain file reaches here as a raw ENOTDIR; name it for the operator either way.
  const info = await lstat(dir).catch((error: NodeJS.ErrnoException) => {
    throw new SocketDirError(`socketDir ${dir} is not a directory (${error.code ?? 'unknown error'})`);
  });
  if (info.isSymbolicLink()) throw new SocketDirError(`socketDir ${dir} must be a directory, not a link`);
  if (!info.isDirectory()) throw new SocketDirError(`socketDir ${dir} is not a directory`);
  if (info.uid !== uid) throw new SocketDirError(`socketDir ${dir} is owned by uid ${info.uid}, not ${uid}`);
  if ((info.mode & 0o077) !== 0) throw new SocketDirError(`socketDir ${dir} must not be accessible to group or others (chmod 700 it)`);
}
