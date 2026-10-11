import 'vitest';

// test-setup.ts extends `toBeLessThanOrEqual` to also compare Date values.
declare module 'vitest' {
  interface Matchers<T = unknown> {
    toBeLessThanOrEqual(expected: number | bigint | Date): T;
  }
}
