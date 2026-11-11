import swc from 'unplugin-swc';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';
import { findSharedDbSpecs } from './test/vitest-db-projects';
import { canRunDbTests } from './test/helpers/test-environment';
import { disableEnvProxy } from './test/helpers/no-env-proxy';

// The runner process — and every worker forked from it — must never see an environment HTTP proxy: the
// suites talk to an in-process server on loopback, and a proxy that intercepts that connection answers
// its own status (typically `407 Proxy Authentication Required`) and fails an unrelated assertion.
// Doing it here, at config load, covers the main process (`globalSetup`/`globalTeardown`, which reach the
// test Postgres) and the repository/env each worker inherits; `test-setup.ts` repeats the call per worker
// so a spec run through another config keeps the same guarantee.
disableEnvProxy();

// Nest DI reads `design:paramtypes`, which Vite's default transform does not emit,
// so specs are compiled with SWC (legacy decorators + decorator metadata).
const swcPlugin = swc.vite({
  module: { type: 'es6' },
  jsc: {
    target: 'es2022',
    parser: { syntax: 'typescript', decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
});

// The nax sandbox withholds host Postgres/Docker; use ordinary isolated workers there.
const DB_MODE = canRunDbTests();
const SPEC_GLOBS = ['src/**/*.spec.ts', 'test/**/*.spec.ts'];
const EXCLUDE = ['**/node_modules/**', '**/dist/**', '.nax/**'];

// Reuse the app graph within bounded groups: one cache for the entire DB tier
// lets a long-lived worker reach its heap limit. Each project gets a fresh worker,
// while files within it still avoid repeated imports. Module mocks stay isolated.
const SHARED_DB_BATCH_SIZE = 25;
const dbProjects = (): TestProjectConfiguration[] => {
  const shared = findSharedDbSpecs(__dirname).sort();
  const batches = Array.from({ length: Math.ceil(shared.length / SHARED_DB_BATCH_SIZE) }, (_, index) =>
    shared.slice(index * SHARED_DB_BATCH_SIZE, (index + 1) * SHARED_DB_BATCH_SIZE),
  );
  return [
    ...batches.map((include, index): TestProjectConfiguration => ({
      extends: true,
      test: {
        name: `db-shared-${index + 1}`, include, exclude: EXCLUDE, isolate: false,
        sequence: { groupOrder: index },
      },
    })),
    {
      extends: true,
      test: {
        name: 'db-isolated', include: SPEC_GLOBS, exclude: [...EXCLUDE, ...shared], isolate: true,
        sequence: { groupOrder: batches.length },
      },
    },
  ];
};

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: true,
    environment: 'node',
    // In DB mode each project sets its own include/exclude: `extends: true` concatenates
    // arrays, so root globs would leak into db-shared.
    ...(!DB_MODE && { include: SPEC_GLOBS, exclude: EXCLUDE }),
    setupFiles: ['./test-setup.ts'],
    globalSetup: ['./test/vitest-global-setup.ts'],
    // DB-backed runs share one Postgres schema, so they stay serial.
    fileParallelism: !DB_MODE,
    ...(DB_MODE && { projects: dbProjects() }),
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts'],
      reportsDirectory: './coverage',
    },
  },
});
