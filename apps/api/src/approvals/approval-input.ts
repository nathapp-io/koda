/**
 * Permissions P3 approval core (US-009): the frozen input an approval request stores, and the hash
 * that proves it did not change between opening and execution (US-011 compares it again).
 *
 * The hash covers `canonicalJson(input)`, not the stored JSON's own text, so two callers assembling
 * the same value in a different member order (a route body, an MCP tool's arguments) deduplicate
 * into one request. The stored value is the plain JSON a round trip answers, because that is what
 * the column holds: reading it back must hash to the same value.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/** The SHA-256 hex of the frozen input's canonical JSON. */
export function approvalInputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

/** The JSON value the request stores: what `JSON.stringify` then `JSON.parse` answers for `input`. */
export function freezeApprovalInput(input: unknown): unknown {
  const text = JSON.stringify(input);
  // `JSON.stringify` answers undefined for a value with no JSON form; the column is non-null.
  return text === undefined ? null : (JSON.parse(text) as unknown);
}
