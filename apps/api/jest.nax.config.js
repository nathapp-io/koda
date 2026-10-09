module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>"],
  testMatch: ["**/.nax/**/*.test.ts"],
  // isolatedModules: transpile without per-file diagnostics — full type checking is
  // the `type-check` job's job; keeping it here made every CI test run ~2x slower.
  transform: { "^.+\\.(t|j)s$": ["ts-jest", { isolatedModules: true }] },
  testEnvironment: "node",
  forceExit: true,
  maxWorkers: 1,
  setupFilesAfterEnv: ["<rootDir>/test-setup.ts"],
  // The acceptance command sets KODA_DB_TESTS=1, so globalSetup pushes the schema to
  // the test Postgres (compose on 5433, else Testcontainers; test/helpers/test-database.ts)
  // and PG-backed acceptance tests run instead of skipping. With no database the run fails loudly.
  globalSetup: "<rootDir>/test/global-setup.ts",
  globalTeardown: "<rootDir>/test/global-teardown.ts",
};