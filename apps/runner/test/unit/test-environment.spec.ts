import { describe, expect, test } from 'bun:test';
import { canRunDbTests, isNaxSandboxed } from '../../../../test/helpers/test-environment';

describe('test environment', () => {
  test.each([
    [undefined, false], ['', false], ['0', false], ['true', false], ['1', true],
  ] as const)('sandbox marker %p means sandboxed=%p', (marker, expected) => {
    expect(isNaxSandboxed({ NAX_SANDBOXED: marker })).toBe(expected);
  });

  test.each([
    [undefined, undefined, false], ['0', undefined, false], ['true', undefined, false],
    ['1', undefined, true], ['1', '0', true], ['1', 'true', true],
    [undefined, '1', false], ['0', '1', false], ['1', '1', false],
  ] as const)('DB flag %p and sandbox marker %p permit DB tests=%p', (db, marker, expected) => {
    expect(canRunDbTests({ KODA_DB_TESTS: db, NAX_SANDBOXED: marker })).toBe(expected);
  });
});
