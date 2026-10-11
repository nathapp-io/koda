import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// DB specs that replace modules need a fresh module graph per file; every other
// DB spec can share one, which skips re-importing the Nest app for each file.
const MODULE_MOCKING = /\bvi\.(mock|doMock|unmock|resetModules)\(/;
const DB_DIRS = ['test/integration', 'test/e2e'];

/** DB spec files (repo-relative) that do not mock modules, so they can share a module cache. */
export function findSharedDbSpecs(root: string): string[] {
  return DB_DIRS.flatMap((dir) =>
    (readdirSync(join(root, dir), { recursive: true }) as string[])
      .filter((file) => file.endsWith('.spec.ts'))
      .map((file) => `${dir}/${file.replace(/\\/g, '/')}`)
      .filter((file) => !MODULE_MOCKING.test(readFileSync(join(root, file), 'utf8'))),
  );
}
