import type { Git, GitOptions, GitResult } from './git';

interface RecordOptions {
  readonly delimiter: '\n' | '\0';
  readonly maxRecordBytes: number;
  /** Returning false ends the command. A null record means it exceeded maxRecordBytes. */
  readonly onRecord: (record: string | null) => boolean | Promise<boolean>;
  /** Inspect a prefix of the raw stream before decoding records. */
  readonly onChunk?: (chunk: Uint8Array) => boolean;
}

/** Frame records on byte boundaries so split UTF-8 survives and even a record without a delimiter is bounded. */
export async function runGitRecords(
  git: Git, args: readonly string[], options: GitOptions, records: RecordOptions,
): Promise<GitResult> {
  const delimiter = records.delimiter.charCodeAt(0);
  const buffer = new Uint8Array(records.maxRecordBytes);
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let length = 0;
  let oversized = false;
  let first = true;

  function emit(bytes: Uint8Array | null, eof = false): boolean | Promise<boolean> {
    const text = bytes === null ? null : decoder.decode(bytes);
    const record = first && text?.startsWith('\uFEFF') ? text.slice(1) : text;
    first = false;
    return eof && record === '' ? true : records.onRecord(record);
  }

  async function onStdout(chunk: Uint8Array, signal?: AbortSignal): Promise<boolean> {
    if (records.onChunk?.(chunk) === false) return false;
    let offset = 0;
    while (offset < chunk.byteLength && !signal?.aborted) {
      const delimiterAt = chunk.indexOf(delimiter, offset);
      const end = delimiterAt === -1 ? chunk.byteLength : delimiterAt;
      if (!oversized) {
        const part = chunk.subarray(offset, end);
        let accepted: boolean | Promise<boolean> = true;
        if (length + part.length > buffer.byteLength) {
          oversized = true;
          accepted = emit(null);
        } else if (delimiterAt !== -1 && length === 0) {
          accepted = emit(part);
        } else {
          buffer.set(part, length);
          length += part.length;
          if (delimiterAt !== -1) accepted = emit(buffer.subarray(0, length));
        }
        if (!(typeof accepted === 'boolean' ? accepted : await accepted)) return false;
      }
      if (delimiterAt === -1) break;
      length = 0;
      oversized = false;
      offset = end + 1;
    }
    return true;
  }

  const result = await git.run(args, { ...options, onStdout });
  if (result.code !== 0 || result.stdoutStopped) return result;
  // Injected Git implementations may still return buffered stdout.
  if (result.stdout && !(await onStdout(new TextEncoder().encode(result.stdout)))) {
    return { ...result, stdoutStopped: true };
  }
  if (!oversized && length > 0 && !(await emit(buffer.subarray(0, length), true))) {
    return { ...result, stdoutStopped: true };
  }
  return result;
}
