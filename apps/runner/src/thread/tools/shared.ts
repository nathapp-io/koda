import { sanitizeDiagnostic } from '../../diagnostics';
import { errorMessage } from '../../errors';
import type { ThreadToolResult } from './types';

/** nax-agent's glob rule for list_files and search_repo; `..` is refused separately. */
const GLOB = /^[A-Za-z0-9._*?/[\]{},-]{1,200}$/;
const TRUNCATED = '[truncated]';
const encoder = new TextEncoder();
const TRUNCATED_BYTES = encoder.encode(TRUNCATED).byteLength;

/** A model-supplied value that the tool rules refuse. */
export class InvalidToolInput extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolInput';
  }
}

export function fieldOf(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

export function checkGlob(value: unknown): string {
  if (typeof value !== 'string' || !GLOB.test(value) || value.includes('..')) throw new InvalidToolInput('invalid glob');
  return value;
}

export function refused(content: string): ThreadToolResult {
  return { content, isError: true };
}

/** Turns any failure of a tool call into an error result, so the agent sees it rather than a rejected run(). */
export async function refuseInvalidInput(run: () => Promise<ThreadToolResult>): Promise<ThreadToolResult> {
  try {
    return await run();
  } catch (error) {
    return refused(sanitizeDiagnostic(errorMessage(error)));
  }
}

/**
 * Joins the lines. A list that is cut (flagged by the caller, or too long for maxBytes) ends with '[truncated]',
 * and then holds only whole leading lines; the marker's bytes are reserved so the result never exceeds maxBytes.
 */
export function joinCapped(lines: readonly string[], maxBytes: number, cut: boolean): string {
  const whole = lines.join('\n');
  if (!cut && encoder.encode(whole).byteLength <= maxBytes) return whole;
  const kept: string[] = [];
  let bytes = 0; // bytes of the kept lines joined with '\n'
  for (const line of lines) {
    const next = bytes + (kept.length > 0 ? 1 : 0) + encoder.encode(line).byteLength;
    if (next + 1 + TRUNCATED_BYTES > maxBytes) break;
    kept.push(line);
    bytes = next;
  }
  return [...kept, TRUNCATED].join('\n');
}

/** Retain only whole leading lines under a byte and entry budget. */
export class CappedLines {
  readonly lines: string[] = [];
  bytes = 0;
  cut = false;

  constructor(readonly maxBytes: number, readonly maxEntries = Infinity) {}

  add(line: string | null): boolean {
    if (this.cut) return false;
    if (line === null || this.lines.length === this.maxEntries) {
      this.cut = true;
      return false;
    }
    const next = this.bytes + (this.lines.length > 0 ? 1 : 0) + encoder.encode(line).byteLength;
    if (next > this.maxBytes) {
      this.cut = true;
      return false;
    }
    this.lines.push(line);
    this.bytes = next;
    return true;
  }

  content(): string {
    return joinCapped(this.lines, this.maxBytes, this.cut);
  }
}

/** Keep an exact count for listings even after the returned prefix fills up. */
export class FileListing {
  private readonly prefix: CappedLines;
  private count = 0;

  constructor(readonly maxEntries: number, readonly maxBytes: number) {
    this.prefix = new CappedLines(maxBytes);
  }

  add(path: string | null): void {
    this.count++;
    if (this.count <= this.maxEntries) this.prefix.add(path);
  }

  content(): string {
    const lines = this.prefix.lines;
    if (!this.prefix.cut && this.count > this.maxEntries) {
      return joinCapped([...lines, `[truncated: ${this.count - this.maxEntries} more]`], this.maxBytes, false);
    }
    return this.prefix.content();
  }
}
