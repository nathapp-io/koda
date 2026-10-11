import swc from 'unplugin-swc';
import { defineConfig, type TestProjectConfiguration } from 'vitest/config';
import { findSharedDbSpecs } from './test/vitest-db-projects';

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

const DB_MODE = process.env.KODA_DB_TESTS === '1';
const SPEC_GLOBS = ['src/**/*.spec.ts', 'test/**/*.spec.ts'];
const EXCLUDE = ['**/node_modules/**', '**/dist/**', '.nax/**'];

// DB mode: re-importing the app graph for each of ~200 serial files was most of the
// run (and twice as slow on CI runners), so DB specs that do not mock modules share
// one module cache (`isolate: false`). Module-mocking specs and anything else stay isolated.
const dbProjects = (): TestProjectConfiguration[] => {
  const shared = findSharedDbSpecs(__dirname);
  return [
    { extends: true, test: { name: 'db-shared', include: shared, exclude: EXCLUDE, isolate: false } },
    { extends: true, test: { name: 'db-isolated', include: SPEC_GLOBS, exclude: [...EXCLUDE, ...shared], isolate: true } },
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
