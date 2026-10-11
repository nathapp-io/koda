import { PathError } from '../../paths/safe-segment';
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

/** Turns a refused input into an error result; any other failure is rethrown. */
export async function refuseInvalidInput(run: () => Promise<ThreadToolResult>): Promise<ThreadToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PathError || error instanceof InvalidToolInput) return refused(error.message);
    throw error;
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
