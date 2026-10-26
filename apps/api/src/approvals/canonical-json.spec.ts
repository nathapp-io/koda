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
});
