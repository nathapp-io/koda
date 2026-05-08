/**
 * Failing tests documenting two adversarial findings in policy-gates-runner.ts.
 *
 * Bug 1 (line 82 — deriveSloSnapshot):
 *   gateResults.gates.filter() is called without guarding against undefined gates.
 *   When gates is absent, this throws TypeError, which is caught by main()'s generic
 *   catch block and calls process.exit(1). The slo-snapshot.json artifact is never
 *   written because the crash happens before fs.writeFile is reached for that file.
 *
 * Bug 2 (lines 40-43 vs line 139 — printSummaryTable guard unreachable):
 *   The Array.isArray guard added to printSummaryTable (lines 40-43) is unreachable.
 *   deriveSloSnapshot is called at line 139, printSummaryTable at line 144. The crash
 *   in deriveSloSnapshot aborts main() before printSummaryTable is ever invoked, so
 *   no summary table is output to stdout regardless of the guard.
 *
 * Spec-correct behavior (from AC-3 and AC-4):
 *   - deriveSloSnapshot must treat undefined/missing gates as an empty array.
 *   - slo-snapshot.json must be written to disk after every CI run.
 *   - printSummaryTable must be called and must output the table to stdout.
 *   - process exit code must be determined by result.passed, not by a crash.
 *
 * How these tests fail / pass:
 *   Current (buggy): deriveSloSnapshot throws TypeError on gates.filter()
 *     → main()'s catch calls process.exit(1)
 *     → fs.writeFile for slo-snapshot.json is never called  (Bug 1 assertion fails)
 *     → printSummaryTable is never called, no table in stdout (Bug 2 assertion fails)
 *   After fix: undefined gates treated as [] → no throw
 *     → fs.writeFile called for slo-snapshot.json         (Bug 1 assertion passes)
 *     → printSummaryTable called, table logged to stdout  (Bug 2 assertion passes)
 */

// ─── module-level state shared with mock factories ───────────────────────────
// Variables prefixed with "mock" are accessible inside jest.mock factories even
// after hoisting.  Do NOT rename them.
// export {} converts this file from a TS script to a module so its top-level
// declarations do not collide with identically-named variables in sibling spec files.
export {};

let mockGateResult: { passed: boolean; blockedReason?: string; gates?: { name: string; passed: boolean }[] } = {
  passed: true,
  gates: [],
};

let mockWriteFilePaths: string[] = [];

// ─── module mocks ─────────────────────────────────────────────────────────────

jest.mock('../../../src/policy/policy-gate.service', () => ({
  PolicyGateService: class MockPolicyGateService {
    async runAllGates() {
      return mockGateResult;
    }
  },
}));

// Prevent NestFactory from attempting a real NestJS bootstrap in unit tests.
// The get() call returns an instance of the already-mocked PolicyGateService so
// runAllGates() reads from mockGateResult as before.
jest.mock('@nestjs/core', () => ({
  NestFactory: {
    createApplicationContext: async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { PolicyGateService: Svc } = require('../../../src/policy/policy-gate.service');
      return {
        get: () => new Svc(),
        close: async () => Promise.resolve(),
      };
    },
  },
}));

// Track writeFile calls so tests can assert slo-snapshot.json was written.
jest.mock('fs/promises', () => ({
  mkdir: () => Promise.resolve(undefined),
  writeFile: (p: unknown) => {
    if (typeof p === 'string') mockWriteFilePaths.push(p);
    return Promise.resolve(undefined);
  },
}));

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Intercept process.exit and return a promise that resolves with the exit code.
 * Returns the spy so the caller can restore it in a finally block.
 */
function interceptExit(): { exitPromise: Promise<number>; exitSpy: jest.SpyInstance } {
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
    resolveExit(typeof code === 'number' ? code : 0);
    return undefined as never;
  });

  return { exitPromise, exitSpy };
}

/** Race the given promise against a 5-second timeout. */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label}`)), 5_000),
    ),
  ]);
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('policy-gates-runner — undefined gates: slo-snapshot.json must be written (Bug 1)', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    process.argv = ['node', 'policy-gates-runner.ts', '--project=test-project'];
    mockWriteFilePaths = [];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('writes slo-snapshot.json when PolicyGateResult.gates is undefined (deriveSloSnapshot must not throw)', async () => {
    // Arrange: gates property absent — triggers TypeError in deriveSloSnapshot at line 82.
    mockGateResult = { passed: true };

    const { exitPromise, exitSpy } = interceptExit();
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Act: loading the module immediately triggers main().catch(…).
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../scripts/policy-gates-runner');

      await withTimeout(exitPromise, 'process.exit was not called within 5 s');

      // Assert: slo-snapshot.json must be written on every successful run.
      // With the bug, deriveSloSnapshot throws before fs.writeFile reaches this path.
      expect(mockWriteFilePaths.some((p) => p.includes('slo-snapshot.json'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});

describe('policy-gates-runner — undefined gates: summary table must be printed to stdout (Bug 2)', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.resetModules();
    process.argv = ['node', 'policy-gates-runner.ts', '--project=test-project'];
    mockWriteFilePaths = [];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('outputs summary table to stdout when PolicyGateResult.gates is undefined (printSummaryTable must be reachable)', async () => {
    // Arrange: gates property absent — deriveSloSnapshot crashes before printSummaryTable.
    mockGateResult = { passed: true };

    const { exitPromise, exitSpy } = interceptExit();

    const capturedLogs: string[] = [];
    const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string') capturedLogs.push(msg);
    });
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      // Act
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../../scripts/policy-gates-runner');

      await withTimeout(exitPromise, 'process.exit was not called within 5 s');

      // Assert: printSummaryTable must have been called and must have logged the table header.
      // With the bug, deriveSloSnapshot crashes at line 139 before printSummaryTable at line 144,
      // so no table lines ever reach stdout.
      expect(capturedLogs.some((msg) => msg.includes('Policy Gate Results'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      consoleLogSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });
});
