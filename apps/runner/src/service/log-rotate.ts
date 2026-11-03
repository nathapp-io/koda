import { constants, createWriteStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

/** OPS-1: launchd holds runner.log open and appends forever; this is the daemon's default ceiling for it. */
export const RUNNER_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * OPS-1: bound a log file a supervisor keeps open. The current bytes are copied to `<path>.1`, replacing the
 * previous rotation, and then the original inode is truncated — launchd holds the descriptor, so renaming the file
 * would leave it writing into the rotated one. Only a file strictly larger than `maxBytes` rotates, and a missing
 * file is not an error. Everything else propagates, and `startDaemon` turns it into a warning: another filesystem
 * error (permissions, a full disk), and a path that is not a regular file — a log this helper can never bound.
 *
 * A symlink is refused, never followed: `lstat` decides, and the copy and the truncate both go through one handle
 * opened `O_NOFOLLOW`, so a path that becomes a link after the check cannot redirect either onto another file.
 */
export async function rotateLogFile(path: string, maxBytes: number): Promise<boolean> {
  let info: Stats;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile()) throw new Error(`${path} is not a regular file, so there is no log to rotate`);
  if (info.size <= maxBytes) return false;
  const source = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    // Streamed, not read into memory: the log is rotated because it is big.
    await pipeline(source.createReadStream({ autoClose: false }), createWriteStream(`${path}.1`));
    await source.truncate(0);
  } finally {
    await source.close();
  }
  return true;
}
