import { stableStringify } from './stable-json';

it('is independent of key order at every depth', () => {
  expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(stableStringify({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }));
  expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
});
