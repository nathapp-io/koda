/**
 * US-009: Replace custom JsonResponse & AppException with @nathapp/nestjs-common
 *
 * Acceptance Criteria:
 * AC-1: apps/api/src/common/json-response.ts does not exist
 * AC-2: apps/api/src/common/app-exception.ts does not exist
 * AC-3: No imports from local ../common/json-response in any file
 * AC-4: No imports from local ../common/app-exception in any file
 * AC-5: No JsonResponse.ok() or JsonResponse.created() or JsonResponse.paginated() calls
 * AC-6: No string-keyed AppException constructor calls (new AppException('string.key', ...))
 * AC-7: Test suite passes with >= 737 tests
 * AC-8: TypeScript compiles without errors
 */

import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function srcExists(relPath: string): boolean {
  return fs.existsSync(path.join(SRC, relPath));
}

/**
 * Recursively collect all .ts files under a directory.
 */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(fullPath);
    }
  }
  return results;
}

const allTsFiles = collectTsFiles(SRC);

// ---------------------------------------------------------------------------
// AC-1: apps/api/src/common/json-response.ts does not exist
// ---------------------------------------------------------------------------

describe('AC-1: local json-response.ts deleted', () => {
  it('src/common/json-response.ts must not exist', () => {
    expect(srcExists('common/json-response.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-2: apps/api/src/common/app-exception.ts does not exist
// ---------------------------------------------------------------------------

describe('AC-2: local app-exception.ts deleted', () => {
  it('src/common/app-exception.ts must not exist', () => {
    expect(srcExists('common/app-exception.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-3: No imports from local ../common/json-response in any file
// ---------------------------------------------------------------------------

describe('AC-3: no imports from local common/json-response', () => {
  const localJsonResponsePattern = /from\s+['"][^'"]*common\/json-response['"]/;

  it('no source file imports from a local common/json-response path', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (localJsonResponsePattern.test(content)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'comments/comments.controller.ts',
    'tickets/tickets.controller.ts',
    'auth/auth.controller.ts',
    'projects/projects.controller.ts',
    'labels/labels.controller.ts',
    'agents/agents.controller.ts',
    'auth/auth.controller.spec.ts',
    'agents/agents.controller.spec.ts',
  ])('%s must not import from local common/json-response', (relPath) => {
    if (!srcExists(relPath)) return; // file may not exist after refactor
    const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
    expect(content).not.toMatch(localJsonResponsePattern);
  });
});

// ---------------------------------------------------------------------------
// AC-4: No imports from local ../common/app-exception in any file
// ---------------------------------------------------------------------------

describe('AC-4: no imports from local common/app-exception', () => {
  const localAppExceptionPattern = /from\s+['"][^'"]*common\/app-exception['"]/;

  it('no source file imports from a local common/app-exception path', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (localAppExceptionPattern.test(content)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'comments/comments.service.ts',
    'tickets/tickets.service.ts',
    'tickets/state-machine/ticket-transitions.ts',
    'tickets/state-machine/ticket-transitions.service.ts',
    'auth/auth.controller.ts',
    'auth/auth.service.ts',
    'auth/auth.service.spec.ts',
    'auth/auth.controller.spec.ts',
    'projects/projects.controller.ts',
    'projects/projects.service.ts',
    'labels/labels.service.ts',
    'agents/agents.service.ts',
    'agents/agents.controller.ts',
    'agents/agents.controller.spec.ts',
    'agents/guards/agent-api-key.guard.ts',
    'tickets/state-machine/ticket-transitions.spec.ts',
    'tickets/state-machine/ticket-transitions.service.spec.ts',
  ])('%s must not import from local common/app-exception', (relPath) => {
    if (!srcExists(relPath)) return; // file may not exist after refactor
    const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
    expect(content).not.toMatch(localAppExceptionPattern);
  });
});

// ---------------------------------------------------------------------------
// AC-5: No JsonResponse.ok() / .created() / .paginated() calls
//        (lowercase method names from the old local class)
// ---------------------------------------------------------------------------

describe('AC-5: no lowercase JsonResponse method calls (.ok / .created / .paginated)', () => {
  // The old local class exposed ok(), created(), paginated() (all lowercase).
  // @nathapp/nestjs-common uses Ok() (capital O). Any lowercase call is a remnant.
  const legacyCallPattern = /JsonResponse\.(ok|created|paginated)\s*\(/;

  it('no source file calls JsonResponse.ok(), .created(), or .paginated()', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (legacyCallPattern.test(content)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'comments/comments.controller.ts',
    'tickets/tickets.controller.ts',
    'auth/auth.controller.ts',
    'projects/projects.controller.ts',
    'labels/labels.controller.ts',
    'agents/agents.controller.ts',
  ])('%s must not call JsonResponse.ok/created/paginated', (relPath) => {
    if (!srcExists(relPath)) return;
    const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
    expect(content).not.toMatch(legacyCallPattern);
  });
});

// ---------------------------------------------------------------------------
// AC-6: No string-keyed AppException constructor calls
// ---------------------------------------------------------------------------

describe('AC-6: no string-keyed AppException constructor calls', () => {
  // Old pattern: new AppException('some.i18nKey', HttpStatus.xxx)
  // New pattern: use typed exception classes like NotFoundAppException, ForbiddenAppException
  const stringKeyedAppExceptionPattern = /new\s+AppException\s*\(\s*['"]/;

  it('no source file constructs AppException with a string i18n key', () => {
    const offenders: string[] = [];
    for (const file of allTsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (stringKeyedAppExceptionPattern.test(content)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    'comments/comments.service.ts',
    'tickets/state-machine/ticket-transitions.ts',
    'tickets/state-machine/ticket-transitions.service.ts',
    'tickets/tickets.service.ts',
    'auth/auth.service.ts',
    'auth/auth.controller.ts',
    'projects/projects.service.ts',
    'labels/labels.service.ts',
    'agents/agents.service.ts',
    'agents/agents.controller.ts',
    'agents/guards/agent-api-key.guard.ts',
  ])('%s must not call new AppException with a string key', (relPath) => {
    if (!srcExists(relPath)) return;
    const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
    expect(content).not.toMatch(stringKeyedAppExceptionPattern);
  });
});

// ---------------------------------------------------------------------------
// AC-7 / AC-8: Structural signals that the codebase compiles cleanly
//              (full compile and test-count gates are run by CI)
// ---------------------------------------------------------------------------

describe('AC-7/AC-8: structural signals for compilability', () => {
  it('@nathapp/nestjs-common is listed as a dependency', () => {
    const pkgPath = path.resolve(__dirname, '../../package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<
      string,
      Record<string, string>
    >;
    const deps = {
      ...(pkg['dependencies'] ?? {}),
      ...(pkg['devDependencies'] ?? {}),
    };
    expect(Object.keys(deps)).toContain('@nathapp/nestjs-common');
  });

  it('controllers that previously used JsonResponse now import from @nathapp/nestjs-common', () => {
    const controllerFiles = [
      'comments/comments.controller.ts',
      'tickets/tickets.controller.ts',
      'auth/auth.controller.ts',
      'projects/projects.controller.ts',
      'labels/labels.controller.ts',
      'agents/agents.controller.ts',
    ];
    const nathappImportPattern = /from\s+['"]@nathapp\/nestjs-common['"]/;
    const filesWithJsonResponseUsage = controllerFiles.filter((relPath) => {
      if (!srcExists(relPath)) return false;
      const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
      // If file uses JsonResponse at all, it must import from @nathapp
      return /JsonResponse/.test(content);
    });
    for (const relPath of filesWithJsonResponseUsage) {
      const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
      expect(content).toMatch(nathappImportPattern);
    }
  });

  it('service files that throw exceptions import from @nathapp/nestjs-common', () => {
    const serviceFiles = [
      'comments/comments.service.ts',
      'tickets/tickets.service.ts',
      'tickets/state-machine/ticket-transitions.ts',
      'tickets/state-machine/ticket-transitions.service.ts',
      'auth/auth.service.ts',
      'projects/projects.service.ts',
      'labels/labels.service.ts',
      'agents/agents.service.ts',
      'agents/guards/agent-api-key.guard.ts',
    ];
    const nathappImportPattern = /from\s+['"]@nathapp\/nestjs-common['"]/;
    const appExceptionUsagePattern =
      /NotFoundAppException|ForbiddenAppException|AuthException|ValidationAppException|AppException/;
    const filesWithExceptionUsage = serviceFiles.filter((relPath) => {
      if (!srcExists(relPath)) return false;
      const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
      return appExceptionUsagePattern.test(content);
    });
    for (const relPath of filesWithExceptionUsage) {
      const content = fs.readFileSync(path.join(SRC, relPath), 'utf-8');
      expect(content).toMatch(nathappImportPattern);
    }
  });
});
