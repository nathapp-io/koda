// Test setup file - runs before each test file
// Note: .env.test loading removed - integration tests need DATABASE_URL set externally
// For unit tests, mocking is used so env vars aren't needed

// Add custom matchers for Date comparisons
// This extends Jest's matchers to allow Date comparisons with toBeLessThanOrEqual
if (typeof expect !== 'undefined' && expect.extend) {
  expect.extend({
    toBeLessThanOrEqual(received: any, expected: any) {
      // Handle Date objects
      const receivedValue = received instanceof Date ? received.getTime() : received;
      const expectedValue = expected instanceof Date ? expected.getTime() : expected;

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
}
