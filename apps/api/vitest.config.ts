import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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

export default defineConfig({
  plugins: [swcPlugin],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.nax/**'],
    setupFiles: ['./test-setup.ts'],
    globalSetup: ['./test/vitest-global-setup.ts'],
    // DB-backed runs (KODA_DB_TESTS=1) share one Postgres schema, so they stay serial.
    fileParallelism: process.env.KODA_DB_TESTS !== '1',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/**/*.spec.ts'],
      reportsDirectory: './coverage',
    },
  },
});
