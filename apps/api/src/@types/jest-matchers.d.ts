declare global {
  namespace jest {
    interface Matchers<R> {
      toBeLessThanOrEqual(expected: number | bigint | Date): R;
      toGreaterThanOrEqual(expected: number | bigint | Date): R;
      toBeLessThan(expected: number | bigint | Date): R;
      toGreaterThan(expected: number | bigint | Date): R;
    }
  }
}

export {};
