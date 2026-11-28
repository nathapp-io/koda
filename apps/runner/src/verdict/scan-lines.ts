import { createReadStream } from 'node:fs';

/**
 * US-006: the longest line this scanner hands to `onLine`. A nax output file is scanned for one marker line, so the
 * reader must not grow with whatever a log holds; a longer line is delivered once, cut, and the rest skipped.
 */
export const MAX_SCAN_LINE_BYTES = 65_536;

const LF = 0x0a;
const CR = 0x0d;

/** A line's text: the bytes up to a `\r` that preceded the `\n` that ended it, decoded as UTF-8. */
function textOf(bytes: Buffer, terminated: boolean): string {
  const end = terminated && bytes.length > 0 && bytes[bytes.length - 1] === CR ? bytes.length - 1 : bytes.length;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * Reads `path` as a stream and calls `onLine` once per line, without its terminator (`\n` or `\r\n`). It resolves
 * `false` when the file does not exist and `true` otherwise; an unreadable path for another reason rejects.
 *
 * `onLine` returns `'stop'` to end the scan. At most `MAX_SCAN_LINE_BYTES` bytes of one line are kept: a longer line is
 * delivered once, cut to that length, and its remainder is dropped up to its terminator, so a single log line never
 * buffers more than the cap. A file without a trailing newline still delivers its last line.
 */
export async function scanLines(path: string, onLine: (line: string) => void | 'stop'): Promise<boolean> {
  const stream = createReadStream(path);
  let pieces: Buffer[] = [];
  let held = 0;         // bytes in `pieces`
  let skipping = false; // past the cap for the current line: drop bytes until its terminator
  try {
    // One chunk is read, split and released at a time; nothing keeps the whole file.
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(LF, offset);
        const end = newline < 0 ? chunk.length : newline;
        const slice = chunk.subarray(offset, end);
        if (!skipping) {
          if (held + slice.length > MAX_SCAN_LINE_BYTES) {
            pieces.push(slice.subarray(0, MAX_SCAN_LINE_BYTES - held));
            const line = textOf(Buffer.concat(pieces), false);
            pieces = [];
            held = 0;
            skipping = true;   // the rest of this line is dropped, not delivered again
            if (onLine(line) === 'stop') return true;
          } else {
            pieces.push(slice);
            held += slice.length;
          }
        }
        if (newline < 0) break;
        offset = newline + 1;
        if (skipping) {
          skipping = false;   // the terminator ends the line that was cut, which was already delivered
          continue;
        }
        const line = textOf(Buffer.concat(pieces), true);
        pieces = [];
        held = 0;
        if (onLine(line) === 'stop') return true;
      }
    }
    if (!skipping && held > 0) {
      onLine(textOf(Buffer.concat(pieces), false));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    stream.destroy();
  }
}
