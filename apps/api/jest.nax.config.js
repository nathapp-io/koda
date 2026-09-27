module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  roots: ["<rootDir>"],
  testMatch: ["**/.nax/**/*.test.ts"],
  transform: { "^.+\\.(t|j)s$": "ts-jest" },
  testEnvironment: "node",
  forceExit: true,
  maxWorkers: 1,
  setupFilesAfterEnv: ["<rootDir>/test-setup.ts"],
  // The acceptance command sets KODA_DB_TESTS=1, so globalSetup pushes the schema to
  // the test Postgres (port 5433) and PG-backed acceptance tests run instead of
  // skipping. With no database the run fails loudly.
  globalSetup: "<rootDir>/test/global-setup.ts",
  globalTeardown: "<rootDir>/test/global-teardown.ts",
};