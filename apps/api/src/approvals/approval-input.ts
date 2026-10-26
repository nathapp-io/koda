/**
 * Permissions P3 approval core (US-009): the frozen input an approval request stores, and the hash
 * that proves it did not change between opening and execution (US-011 compares it again).
 *
 * The hash covers `canonicalJson` of the *frozen* value, not the stored JSON's own text, so two
 * callers assembling the same value in a different member order (a route body, an MCP tool's
 * arguments) deduplicate into one request. The stored value is the plain JSON a round trip answers,
 * because that is what the column holds: reading it back must hash to the same value.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';

/**
 * The SHA-256 hex of the frozen input's canonical JSON.
 *
 * The value is frozen (JSON round-tripped) before it is canonicalised, so the hash always describes
 * what the request stores. `canonicalJson` alone answers for a JSON *value*; the parsed input is a
 * JavaScript value, and some of those only JSON writes apart — a boxed `new Number(7)` is an object
 * with no own keys, so canonicalising it raw collapses `{ amount: new Number(7) }` and
 * `{ amount: new Number(8) }` onto one hash while the column stores 7 and 8. Freezing first makes
 * two distinct stored values hash differently, and makes re-hashing a stored `input` (US-011's
 * integrity check) reproduce this hash exactly.
 */
export function approvalInputHash(input: unknown): string {
  return createHash('sha256').update(canonicalJson(freezeApprovalInput(input)), 'utf8').digest('hex');
}

/** The JSON value the request stores: what `JSON.stringify` then `JSON.parse` answers for `input`. */
export function freezeApprovalInput(input: unknown): unknown {
  const text = JSON.stringify(input);
  // `JSON.stringify` answers undefined for a value with no JSON form; the column is non-null.
  return text === undefined ? null : (JSON.parse(text) as unknown);
}
