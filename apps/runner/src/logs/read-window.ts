import { stat } from 'node:fs/promises';

export interface LogWindow {
  readonly fileSize: number;
  readonly bytes: Buffer;
}

/**
 * Spec §2.4: the next bytes of a log file as raw bytes (never decoded). At most `maxBytes`, cut after the last `\n`;
 * a full window with no newline is sent whole (R12); `toEnd` (draining) sends everything in the window.
 * Returns null when the file does not exist.
 */
export async function readWindow(path: string, from: number, maxBytes: number, toEnd: boolean): Promise<LogWindow | null> {
  let fileSize: number;
  try {
    fileSize = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (fileSize <= from) return { fileSize, bytes: Buffer.alloc(0) };
  const raw = Buffer.from(await Bun.file(path).slice(from, Math.min(fileSize, from + maxBytes)).arrayBuffer());
  if (toEnd) return { fileSize, bytes: raw };
  const cut = raw.lastIndexOf(0x0a) + 1;
  if (cut > 0) return { fileSize, bytes: raw.subarray(0, cut) };
  return { fileSize, bytes: raw.length >= maxBytes ? raw : Buffer.alloc(0) };
}
