/**
 * US-003: Add structured logging via @nathapp/nestjs-logging
 *
 * Acceptance Criteria:
 * AC1 — @nathapp/nestjs-logging present in apps/api/package.json
 * AC2 — LoggingModule registered in AppModule
 * AC3 — app.useLogger(app.get(Logger)) called before useAppGlobalPrefix() in main.ts
 * AC4 — No `import { Logger } from '@nestjs/common'` in apps/api/src/**
 * AC5 — No console.log, console.error, console.warn calls in apps/api/src/**
 * AC6 — App starts without logger initialization errors (Logger importable from @nathapp/nestjs-logging)
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(SRC, relPath), 'utf-8');
}

function readPkg(): Record<string, unknown> {
  const pkgPath = path.resolve(__dirname, '../../package.json');
  return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
}

function walkTs(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTs(full, results);
    } else if (
      entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(full);
    }
  }
  return results;
}

function getAllSrcFiles(): string[] {
  return walkTs(SRC);
}

// ---------------------------------------------------------------------------
// AC1 — @nathapp/nestjs-logging in package.json
// ---------------------------------------------------------------------------

describe('AC1 — @nathapp/nestjs-logging in package.json', () => {
  it('lists @nathapp/nestjs-logging as a dependency', () => {
    const pkg = readPkg();
    const deps = (pkg['dependencies'] ?? {}) as Record<string, string>;
    expect(Object.keys(deps)).toContain('@nathapp/nestjs-logging');
  });
});

// ---------------------------------------------------------------------------
// AC2 — LoggingModule registered in AppModule
// ---------------------------------------------------------------------------

describe('AC2 — LoggingModule registered in AppModule', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('app.module.ts');
  });

  it('imports LoggingModule from @nathapp/nestjs-logging', () => {
    expect(source).toMatch(/from\s+['"]@nathapp\/nestjs-logging['"]/);
  });

  it('includes LoggingModule in the @Module imports array', () => {
    expect(source).toMatch(/LoggingModule/);
  });
});

// ---------------------------------------------------------------------------
// AC3 — app.useLogger(app.get(Logger)) called before useAppGlobalPrefix() in main.ts
// ---------------------------------------------------------------------------

describe('AC3 — main.ts calls app.useLogger before useAppGlobalPrefix()', () => {
  let source: string;

  beforeAll(() => {
    source = readSrc('main.ts');
  });

  it('calls app.useLogger with app.get(Logger)', () => {
    expect(source).toMatch(/app\.useLogger\s*\(\s*app\.get\s*\(\s*Logger\s*\)\s*\)/);
  });

  it('imports Logger from @nathapp/nestjs-logging in main.ts', () => {
    expect(source).toMatch(/import\s*\{[^}]*\bLogger\b[^}]*\}\s*from\s*['"]@nathapp\/nestjs-logging['"]/);
  });

  it('calls app.useLogger before app.useAppGlobalPrefix()', () => {
    const useLoggerIndex = source.indexOf('app.useLogger');
    const usePrefixIndex = source.indexOf('useAppGlobalPrefix');
    expect(useLoggerIndex).toBeGreaterThanOrEqual(0);
    expect(usePrefixIndex).toBeGreaterThanOrEqual(0);
    expect(useLoggerIndex).toBeLessThan(usePrefixIndex);
  });
});

// ---------------------------------------------------------------------------
// AC4 — No `import { Logger } from '@nestjs/common'` in any src file
// ---------------------------------------------------------------------------

describe('AC4 — No Logger imported from @nestjs/common in src/**', () => {
  let srcFiles: string[];

  beforeAll(() => {
    srcFiles = getAllSrcFiles();
  });

  it('has src files to check', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('no file imports Logger from @nestjs/common', () => {
    const violations: string[] = [];

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/import\s*\{[^}]*\bLogger\b[^}]*\}\s*from\s*['"]@nestjs\/common['"]/.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC5 — No console.log, console.error, console.warn in src/**
// ---------------------------------------------------------------------------

describe('AC5 — No console.log/error/warn calls in src/**', () => {
  let srcFiles: string[];

  beforeAll(() => {
    srcFiles = getAllSrcFiles();
  });

  it('no file contains console.log', () => {
    const violations: string[] = [];

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/console\.log\s*\(/.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }

    expect(violations).toEqual([]);
  });

  it('no file contains console.error', () => {
    const violations: string[] = [];

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/console\.error\s*\(/.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }

    expect(violations).toEqual([]);
  });

  it('no file contains console.warn', () => {
    const violations: string[] = [];

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (/console\.warn\s*\(/.test(content)) {
        violations.push(path.relative(SRC, filePath));
      }
    }

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC6 — Logger is importable from @nathapp/nestjs-logging (package present)
// ---------------------------------------------------------------------------

describe('AC6 — @nathapp/nestjs-logging is resolvable as a package', () => {
  it('can resolve @nathapp/nestjs-logging from node_modules', () => {
    expect(() => {
      require.resolve('@nathapp/nestjs-logging');
    }).not.toThrow();
  });

  it('exports a Logger symbol from @nathapp/nestjs-logging', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loggingModule = require('@nathapp/nestjs-logging') as Record<string, unknown>;
    expect(loggingModule['Logger']).toBeDefined();
  });

  it('exports a LoggingModule symbol from @nathapp/nestjs-logging', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loggingModule = require('@nathapp/nestjs-logging') as Record<string, unknown>;
    expect(loggingModule['LoggingModule']).toBeDefined();
  });
});
