// Exercise the built API in a fresh Bun process, isolated from shell settings and Nest's .env lookup.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

function checkCompilerLoad() {
  const morphEntry = require.resolve('ts-morph');
  function assertCompilerLoaded(expected) {
    assert.equal(Boolean(require.cache[morphEntry]), expected, 'ts-morph load state');
    const compilerLoaded = Object.keys(require.cache).some((path) =>
      path.endsWith('/@ts-morph/common/dist/typescript.js'),
    );
    assert.equal(compilerLoaded, expected, 'bundled TypeScript compiler load state');
  }

  require('../dist/app.module.js');
  assertCompilerLoaded(false);

  const { CodeGraphService } = require('../dist/code-intel/code-graph.service.js');
  const graph = new CodeGraphService();
  assert.deepEqual(graph.extractBatch([]), []);
  assertCompilerLoaded(false);

  const [file] = graph.extractBatch([{ path: 'example.ts', content: 'export function example() {}' }]);
  assert.deepEqual(file.symbols.map((symbol) => symbol.name), ['example']);
  assertCompilerLoaded(true);
}

if (process.argv[2] === '--probe') {
  checkCompilerLoad();
} else {
  const cwd = mkdtempSync(join(tmpdir(), 'koda-compiler-load-'));
  try {
    execFileSync(process.execPath, ['--no-env-file', __filename, '--probe'], {
      cwd,
      stdio: 'inherit',
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        JWT_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        API_KEY_SECRET: 'c'.repeat(48),
      },
    });
  } finally {
    rmdirSync(cwd);
  }
}
