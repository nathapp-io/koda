/**
 * Build guard: fail when compiled output requires a Bun isolated-store path.
 *
 * The @nestjs/swagger CLI plugin emits `require(".bun/<pkg>@<ver>+<peer-hash>/...")`
 * for a DTO property typed with an enum from a package (it strips the path up to the
 * first `node_modules/` only). That resolves in the dev checkout but not in the
 * production image, whose install has a different peer hash, so the API cannot boot.
 * Fix a hit by typing the property as the enum's string-literal union and keeping
 * `enum:` on the decorator.
 *
 * Usage: bun scripts/check-dist-requires.ts [distDir]   (default: dist)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StoreRequireHit {
  file: string;
  line: number;
}

// Any require/import whose specifier reaches into the store: `.bun/...`,
// `../node_modules/.bun/...` or `/app/node_modules/.bun/...`.
const STORE_REQUIRE = /\b(?:require|import)\s*\(\s*["'`](?:[^"'`]*\/)?\.bun\//;
const JS_FILE = /\.[cm]?js$/;

function listJsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsFiles(full);
    return entry.isFile() && JS_FILE.test(entry.name) ? [full] : [];
  });
}

export function findStoreRequires(distDir: string): StoreRequireHit[] {
  return listJsFiles(distDir).flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        STORE_REQUIRE.test(text) ? [{ file: path.relative(distDir, file), line: index + 1 }] : [],
      ),
  );
}

function main(): void {
  const distDir = path.resolve(process.argv[2] ?? 'dist');
  if (!fs.existsSync(distDir)) {
    process.stderr.write(`check-dist-requires: ${distDir} does not exist\n`);
    process.exit(1);
  }

  const hits = findStoreRequires(distDir);
  if (hits.length > 0) {
    const lines = hits.map((hit) => `  ${hit.file}:${hit.line}`).join('\n');
    process.stderr.write(
      `check-dist-requires: compiled output requires a Bun store path (breaks the production image):\n${lines}\n` +
        'Type the DTO property as the enum string-literal union; keep `enum:` on the decorator.\n',
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
