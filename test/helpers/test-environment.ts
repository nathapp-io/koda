type TestEnvironment = Readonly<Record<string, string | undefined>>;

/** Advisory marker set on commands wrapped by a nax session sandbox. */
export function isNaxSandboxed(env: TestEnvironment = process.env): boolean {
  return env.NAX_SANDBOXED === '1';
}

/** Real Postgres/Docker suites run only on an opted-in host. */
export function canRunDbTests(env: TestEnvironment = process.env): boolean {
  return env.KODA_DB_TESTS === '1' && !isNaxSandboxed(env);
}
