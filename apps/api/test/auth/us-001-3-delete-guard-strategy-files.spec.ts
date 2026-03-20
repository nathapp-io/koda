/**
 * US-001-3: Delete custom guard and strategy files
 *
 * Acceptance Criteria:
 * AC1 — Files jwt-auth.guard.ts, api-key-auth.guard.ts, combined-auth.guard.ts,
 *        jwt.strategy.ts no longer exist
 * AC2 — No import in apps/api/src references any of the deleted files
 * AC3 — bun run --cwd apps/api type-check exits 0 after deletion
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SRC = path.resolve(__dirname, '../../src');
const API_ROOT = path.resolve(__dirname, '../..');

function srcExists(relPath: string): boolean {
  return fs.existsSync(path.join(SRC, relPath));
}

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// AC1 — Target files must not exist
// ---------------------------------------------------------------------------

describe('AC1 — deleted files no longer exist in src', () => {
  it('jwt-auth.guard.ts has been deleted', () => {
    expect(srcExists('auth/guards/jwt-auth.guard.ts')).toBe(false);
  });

  it('api-key-auth.guard.ts has been deleted', () => {
    expect(srcExists('auth/guards/api-key-auth.guard.ts')).toBe(false);
  });

  it('combined-auth.guard.ts has been deleted', () => {
    expect(srcExists('auth/guards/combined-auth.guard.ts')).toBe(false);
  });

  it('jwt.strategy.ts has been deleted', () => {
    expect(srcExists('auth/strategies/jwt.strategy.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC2 — No remaining imports reference the deleted files
// ---------------------------------------------------------------------------

describe('AC2 — no src file imports the deleted files', () => {
  const importPattern =
    /from\s+['"]([^'"]*(?:jwt-auth\.guard|api-key-auth\.guard|combined-auth\.guard|jwt\.strategy))['"]/;

  it('auth.module.ts has no imports of deleted files', () => {
    const content = readSrc('auth/auth.module.ts');
    expect(content).not.toMatch(importPattern);
  });

  it('agents.module.ts has no imports of deleted files', () => {
    const content = readSrc('agents/agents.module.ts');
    expect(content).not.toMatch(importPattern);
  });

  it('agents.controller.ts has no imports of deleted files', () => {
    const content = readSrc('agents/agents.controller.ts');
    expect(content).not.toMatch(importPattern);
  });

  it('auth.controller.ts has no imports of deleted files', () => {
    const content = readSrc('auth/auth.controller.ts');
    expect(content).not.toMatch(importPattern);
  });

  it('projects.controller.ts has no imports of deleted files', () => {
    const content = readSrc('projects/projects.controller.ts');
    expect(content).not.toMatch(importPattern);
  });

  it('no file anywhere in src/ imports a deleted file', () => {
    const allFiles = getAllTsFiles(SRC);
    const violations: string[] = [];

    for (const file of allFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (importPattern.test(content)) {
        violations.push(path.relative(SRC, file));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC3 — TypeScript compilation passes cleanly after deletion
// ---------------------------------------------------------------------------

describe('AC3 — TypeScript type-check exits 0', () => {
  it('bun run type-check succeeds with no errors', () => {
    const result = spawnSync('bun', ['run', 'type-check'], {
      cwd: API_ROOT,
      encoding: 'utf-8',
    });

    if (result.status !== 0) {
      console.error('type-check stdout:\n', result.stdout);
      console.error('type-check stderr:\n', result.stderr);
    }

    expect(result.status).toBe(0);
  });
});
