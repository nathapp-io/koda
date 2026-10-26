import { canonicalJson } from './canonical-json';

/**
 * P3 approval core (US-007). The hash of an approval request's frozen input must not change when a
 * caller assembles the same value in a different key order, so the serializer sorts keys at every
 * depth and emits no whitespace.
 */
describe('canonicalJson', () => {
  it('AC-6: sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('AC-7: keeps array order', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });

  it('serialises primitives without whitespace', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson('a "b"')).toBe('"a \\"b\\""');
    expect(canonicalJson(1.5)).toBe('1.5');
  });

  it('emits the same string for the same value in a different key order', () => {
    const first = { labelId: 'l1', project: { name: 'k', id: 'p1' } };
    const second = { project: { id: 'p1', name: 'k' }, labelId: 'l1' };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('drops undefined object members and nulls undefined array members, like JSON.stringify', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([1, undefined])).toBe('[1,null]');
  });

  it('serialises a value that carries toJSON through it', () => {
    expect(canonicalJson({ at: new Date(0), ok: true })).toBe('{"at":"1970-01-01T00:00:00.000Z","ok":true}');
  });

  // Review fix round 1, F1: a toJSON that answers an object must be canonicalised like any other
  // object, or the input hashed at gate time differs from the same input read back from jsonb.
  it('F1: sorts the object a toJSON answers, matching the value\'s JSON round-trip', () => {
    const value = { toJSON: () => ({ b: 1, a: { d: 2, c: 3 } }) };
    const roundTripped = JSON.parse(JSON.stringify(value)) as unknown;

    expect(canonicalJson(value)).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson(value)).toBe(canonicalJson(roundTripped));
  });

  it('F1: canonicalises an object-valued toJSON at any depth', () => {
    const value = { z: [{ toJSON: () => ({ b: 1, a: 2 }) }], a: 0 };

    expect(canonicalJson(value)).toBe('{"a":0,"z":[{"a":2,"b":1}]}');
  });

  // Review fix round 1, F2: a hole is a position JSON.stringify writes as null. Skipping it loses
  // content (two different sparse arrays would hash alike) and can emit invalid JSON.
  it('F2: writes a sparse array hole as null and keeps its position', () => {
    expect(canonicalJson(new Array<unknown>(1))).toBe('[null]');
    expect(canonicalJson(new Array<unknown>(2))).toBe('[null,null]');

    const mixed = new Array<unknown>(3);
    mixed[0] = 1;
    mixed[2] = 3;
    expect(canonicalJson(mixed)).toBe('[1,null,3]');
  });

  it('F2: a sparse array hashes the same as its JSON round-trip', () => {
    const mixed = new Array<unknown>(3);
    mixed[0] = 1;
    mixed[2] = 3;

    expect(canonicalJson(mixed)).toBe(canonicalJson(JSON.parse(JSON.stringify(mixed))));
  });

  it('agrees with its own JSON round-trip for every JSON-serialisable shape', () => {
    const values: unknown[] = [
      { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } },
      { at: new Date(0), amount: { toJSON: () => ({ b: '1.00', a: '2.00' }) } },
      [{ toJSON: () => ({ z: 1, a: [2, 3] }) }],
      [1, undefined, 3],
      new Array<unknown>(2),
      'text',
      0,
      null,
      true,
    ];

    for (const value of values) {
      expect(canonicalJson(value)).toBe(canonicalJson(JSON.parse(JSON.stringify(value))));
    }
  });
});
