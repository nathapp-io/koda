import { compareCore, formatCore, parseCoreVersion } from './nax-version';

describe('nax core version (S2b (c) §2.4, D412)', () => {
  it.each([
    ['0.83.3', [0, 83, 3]],
    ['0.83.3-canary.2', [0, 83, 3]],
    ['v1.2.3', [1, 2, 3]],
    [' 1.0.0+build.7 ', [1, 0, 0]],
  ])('parses %s', (raw, core) => {
    expect(parseCoreVersion(raw)).toEqual(core);
  });

  it.each([[''], ['abc'], ['1.2'], ['1.2.x'], [null], [undefined]])('treats %p as unknown', (raw) => {
    expect(parseCoreVersion(raw)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareCore([0, 83, 10], [0, 83, 9])).toBeGreaterThan(0);
    expect(compareCore([0, 9, 0], [0, 10, 0])).toBeLessThan(0);
    expect(compareCore([1, 0, 0], [1, 0, 0])).toBe(0);
    expect(formatCore([0, 83, 10])).toBe('0.83.10');
  });
});
