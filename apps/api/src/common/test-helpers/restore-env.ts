import { afterEach } from 'vitest';

/**
 * Snapshots `process.env` when called (at describe/module level) and restores it
 * after every test, so env mutations (including deletes of values loaded from
 * `.env.test`) cannot leak into later tests in the same file.
 */
export function restoreEnvAfterEach(): void {
  const snapshot = { ...process.env };
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
