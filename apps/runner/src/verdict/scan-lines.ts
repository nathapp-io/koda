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
 * A failure of `onLine`, wrapped so the outer catch can tell it apart from an error of the file read (review B3): a
 * callback that fails with an `ENOENT` of its own must not be reported as a missing input file.
 */
class CallbackFailure {
  constructor(readonly cause: unknown) {}
}

/**
 * Reads `path` as a stream and calls `onLine` once per line, without its terminator (`\n` or `\r\n`). It resolves
 * `false` when the file does not exist and `true` otherwise; an unreadable path for another reason rejects, and so
 * does a failure of `onLine`, with its own error (an `ENOENT` of the callback is not a missing file, review B3).
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
  // Every callback is wrapped: an error it throws is the caller's, never a reason to answer "no such file" (B3).
  const emit = (line: string): boolean => {
    try {
      return onLine(line) === 'stop';
    } catch (error) {
      throw new CallbackFailure(error);
    }
  };
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
            if (emit(line)) return true;
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
        if (emit(line)) return true;
      }
    }
    if (!skipping && held > 0) {
      emit(textOf(Buffer.concat(pieces), false));
    }
    return true;
  } catch (error) {
    // A callback failure is rethrown as it is: only the file read may answer "the file does not exist" (B3).
    if (error instanceof CallbackFailure) throw error.cause;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    stream.destroy();
  }
}
