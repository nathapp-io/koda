/**
 * P3 approval core (US-007): the deterministic JSON string an approval request hashes.
 *
 * Two callers assemble the same value in different key orders (a route's body, an MCP tool's
 * arguments), so the hash of the frozen input must not depend on member order. Object keys are
 * sorted at every depth, array order is kept (it is meaningful: an approval of `[a, b]` is not an
 * approval of `[b, a]`) and no whitespace is emitted.
 *
 * The output is the string `JSON.stringify` would produce for the value with its keys sorted, so a
 * reader can parse it back: `undefined` object members are dropped, `undefined` array members and
 * sparse-array holes become `null`, and a value that carries `toJSON` (a `Date`, a `Prisma.Decimal`,
 * an object with its own JSON form) is serialised through what `toJSON` answers, then sorted like any
 * other value. `canonicalJson(x)` and `canonicalJson(JSON.parse(JSON.stringify(x)))` therefore agree
 * for every JSON-serialisable `x` — which is what makes the gate's hash match the stored `input`.
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
    // `toJSON` may answer an object, not just a string: canonicalise what `JSON.stringify` produced
    // for it, so a value hashed here equals the same value read back from the persisted JSON.
    return serialize(normalizeThroughJson(value));
  }
  if (Array.isArray(value)) return serializeArray(value);
  if (typeof value === 'object' && value !== null) return serializeObject(value);
  return serializeLeaf(value);
}

/** The plain JSON value `JSON.stringify` writes for `value` (`toJSON` already applied). */
function normalizeThroughJson(value: object): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

/** A leaf's own JSON: primitives as `JSON.stringify` writes them, `undefined` as `null`. */
function serializeLeaf(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function serializeArray(items: readonly unknown[]): string {
  // Indexed, not `map`: `map` skips holes, which would drop a position (two different sparse arrays
  // would hash alike) and can emit invalid JSON. A hole reads as `undefined`, which `JSON.stringify`
  // also writes as `null`, so a position is never lost.
  const members: string[] = [];
  for (let index = 0; index < items.length; index += 1) members.push(serialize(items[index]));

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
