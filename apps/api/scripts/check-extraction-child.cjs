// Exercise the built extraction child in a fresh Bun process: one request on stdin in, JSON on stdout out.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// The compiled child beside this checkout's dist, not the source file.
const CHILD = join(__dirname, '..', 'dist', 'code-intel', 'extraction-child.js');
const RESPONSE_LIMIT = 32 * 1024 * 1024;

function checkExtractionChild() {
  const cwd = mkdtempSync(join(tmpdir(), 'koda-extraction-child-'));
  try {
    const stdout = execFileSync(process.execPath, ['--no-env-file', CHILD], {
      cwd,
      input: JSON.stringify({ files: [{ path: 'src/example.ts', content: 'export function example() {}' }] }),
      encoding: 'utf8',
      maxBuffer: RESPONSE_LIMIT,
      env: {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://test:test@localhost/test',
        JWT_SECRET: 'a'.repeat(48),
        JWT_REFRESH_SECRET: 'b'.repeat(48),
        API_KEY_SECRET: 'c'.repeat(48),
      },
    });

    const { results } = JSON.parse(stdout);
    assert.equal(results.length, 1, 'one result per request file');
    assert.equal(results[0].path, 'src/example.ts', 'result path');
    assert.deepEqual(
      results[0].symbols.map((symbol) => symbol.name),
      ['example'],
      'extracted symbol',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

checkExtractionChild();
