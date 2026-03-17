// Test setup file - runs before each test file
// Note: .env.test loading removed - integration tests need DATABASE_URL set externally
// For unit tests, mocking is used so env vars aren't needed

// Add custom matchers for Date comparisons
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).expect?.extend?.({
  toBeLessThanOrEqual(received: unknown, expected: unknown) {
    // Handle Date objects
    const receivedValue = received instanceof Date ? received.getTime() : (received as number);
    const expectedValue = expected instanceof Date ? expected.getTime() : (expected as number);

    const pass = receivedValue <= expectedValue;

    return {
      pass,
      message: () =>
        pass
          ? `expected ${receivedValue} not to be less than or equal to ${expectedValue}`
          : `expected ${receivedValue} to be less than or equal to ${expectedValue}`,
    };
  },
});
