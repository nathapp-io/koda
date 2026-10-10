import { defineConfig } from 'vitest/config';
import baseConfig from './vitest.config';

// nax acceptance runs: the generated `.nax/features/<feature>/.nax-acceptance.test.ts`
// files are outside the default spec globs. The acceptance command sets KODA_DB_TESTS=1,
// so globalSetup pushes the schema to the test Postgres (compose on 5433, else
// Testcontainers; test/helpers/test-database.ts) and PG-backed tests run instead of skipping.
// Spread rather than mergeConfig: mergeConfig concatenates include/exclude arrays.
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: ['.nax/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
