/**
 * P3 approval core (US-007): the deterministic JSON string an approval request hashes.
 *
 * Two callers assemble the same value in different key orders (a route's body, an MCP tool's
 * arguments), so the hash of the frozen input must not depend on member order. Object keys are
 * sorted at every depth, array order is kept (it is meaningful: an approval of `[a, b]` is not an
 * approval of `[b, a]`) and no whitespace is emitted.
 *
 * The output is the string `JSON.stringify` would produce for the value with its keys sorted, so a
 * reader can parse it back: `undefined` object members are dropped, `undefined` array members become
 * `null`, and a value that carries `toJSON` (a `Date`, a `Prisma.Decimal`) is serialised through it.
 */

const OPEN_OBJECT = '{';
const CLOSE_OBJECT = '}';
const OPEN_ARRAY = '[';
const CLOSE_ARRAY = ']';
const SEPARATOR = ',';
const NAME_SEPARATOR = ':';

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (typeof value === 'object' && value !== null && hasCustomToJson(value)) {
    return serializeLeaf(value);
  }
  if (Array.isArray(value)) return serializeArray(value);
  if (typeof value === 'object' && value !== null) return serializeObject(value);
  return serializeLeaf(value);
}

/** A leaf's own JSON: primitives as `JSON.stringify` writes them, `undefined` as `null`. */
function serializeLeaf(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function serializeArray(items: readonly unknown[]): string {
  const members = items.map((item) => serialize(item));
  return `${OPEN_ARRAY}${members.join(SEPARATOR)}${CLOSE_ARRAY}`;
}

function serializeObject(value: object): string {
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .sort()
    // JSON.stringify omits a member whose value is undefined; mirror it, so the output parses back
    // to the same value that was hashed.
    .filter((key) => record[key] !== undefined)
    .map((key) => `${serializeLeaf(key)}${NAME_SEPARATOR}${serialize(record[key])}`);
  return `${OPEN_OBJECT}${members.join(SEPARATOR)}${CLOSE_OBJECT}`;
}

function hasCustomToJson(value: object): boolean {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}
