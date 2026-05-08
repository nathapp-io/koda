/**
 * Failing test for adversarial review finding in policy-gates-runner.ts
 *
 * Bug (scripts/policy-gates-runner.ts:40):
 *   printSummaryTable iterates over gateResults.gates with a bare for-of loop:
 *     for (const gate of gateResults.gates) { ... }
 *   If gateResults.gates is undefined the loop throws:
 *     TypeError: gateResults.gates is not iterable
 *
 * Note: deriveSloSnapshot (line 77) contains the same defect and is called
 * before printSummaryTable inside main(), so the crash manifests there first.
 * Both sites require the same defensive guard.
 *
 * Spec-correct behavior: neither printSummaryTable nor deriveSloSnapshot should
 * throw when gateResults.gates is undefined or missing.  They must guard the
 * loop (e.g. with Array.isArray) and treat a missing gates array as an empty
 * collection.  The process exit code must be determined solely by result.passed,
 * not by a crash caught in main()'s generic catch block.
 *
 * How the test fails / passes:
 *   Current (buggy): deriveSloSnapshot throws TypeError → main()'s catch block
 *     calls process.exit(1) → expect(code).toBe(0) FAILS
 *   After fix: undefined gates treated as [] → result.passed=true → process.exit(0)
 *     → expect(code).toBe(0) PASSES
 */

// ─── module-level state shared with mock factory ──────────────────────────────
// The jest.mock factory is hoisted before imports, but the variable initialiser
// runs before any test.  Reassigning mockGateResult in a test controls what
// runAllGates returns in that test because the factory reads the variable by
// reference each time the mock module is loaded.

let mockGateResult: { passed: boolean; gates?: { name: string; passed: boolean }[] } = {
  passed: true,
  gates: [],
};

// ─── module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../../src/policy/policy-gate.service', () => ({
  PolicyGateService: class MockPolicyGateService {
    async runAllGates() {
      return mockGateResult;
    }
  },
}));

// Prevent real filesystem I/O; simple arrow functions survive jest.resetModules().
jest.mock('fs/promises', () => ({
  mkdir: () => Promise.resolve(undefined),
  writeFile: () => Promise.resolve(undefined),
}));

// ─── tests ────────────────────────────────────────────────────────────────────

describe('policy-gates-runner — printSummaryTable: undefined gates must not crash the script', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    // Reset the module registry so each test reloads the script fresh and
    // re-triggers main().  The jest.mock registrations (factories) are unaffected
    // by jest.resetModules() and continue to apply to the fresh require.
    jest.resetModules();
    process.argv = ['node', 'policy-gates-runner.ts', '--project=test-project'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('exits with code 0 when result.passed is true and gates is missing from PolicyGateResult', async () => {
    // Arrange: PolicyGateResult with passed=true but no gates property (undefined).
    // This is the minimal input that triggers the bug in deriveSloSnapshot/printSummaryTable.
    mockGateResult = { passed: true };

    // Intercept process.exit so the test process does not terminate.
    // Resolve exitPromise when exit is called so we can await the async main().
    let resolveExit!: (code: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      resolveExit(typeof code === 'number' ? code : 0);
      return undefined as never;
    });

    try {
      // Act: require the script — its module body calls main().catch(...) immediately.
      // The require itself returns synchronously; main() completes asynchronously and
      // signals completion via process.exit.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../scripts/policy-gates-runner');

      // Wait for main() to finish.  5 s is generous for a unit test; a timeout here
      // means process.exit was never called, which is itself a bug.
      const code = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timeout: process.exit was not called within 5 s')),
            5_000,
          ),
        ),
      ]);

      // Assert: with the bug, deriveSloSnapshot throws TypeError on gates.filter(...)
      //   → caught by main()'s catch → process.exit(1).
      // With the fix, undefined gates are treated as [] → no throw → result.passed=true
      //   → process.exit(0).
      expect(code).toBe(0);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
