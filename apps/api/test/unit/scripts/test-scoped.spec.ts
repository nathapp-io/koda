import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildScopedRun, expandTargets, hasUnresolvedTarget, needsDatabase } from '../../../scripts/test-scoped';

describe('test-scoped', () => {
  describe('needsDatabase', () => {
    it('is false for unit specs only', () => {
      expect(needsDatabase(['src/projects/projects.service.spec.ts', 'test/unit/config/env-validation.spec.ts'])).toBe(false);
    });

    it('is true when any path is an integration spec', () => {
      expect(
        needsDatabase([
          'src/projects/projects.service.spec.ts',
          '/repo/apps/api/test/integration/projects/project-membership-gate.integration.spec.ts',
        ]),
      ).toBe(true);
    });

    it('is true for an e2e spec', () => {
      expect(needsDatabase(['test/e2e/tickets.e2e.spec.ts'])).toBe(true);
    });

    it('is false for no paths', () => {
      expect(needsDatabase([])).toBe(false);
    });

    it('ignores integration/e2e in parent directory names', () => {
      expect(
        needsDatabase([
          '/work/koda-e2e-fix/apps/api/src/x.spec.ts',
          '/work/integration-sandbox/apps/api/test/unit/y.spec.ts',
        ]),
      ).toBe(false);
    });

    it('is true for a DB-gated spec name outside test/integration', () => {
      expect(needsDatabase(['src/foo/foo.integration.spec.ts'])).toBe(true);
    });

    it('is true for a unit-named spec under test/integration', () => {
      expect(needsDatabase(['test/integration/memory/memory-governance.unit.spec.ts'])).toBe(true);
    });
  });

  describe('buildScopedRun', () => {
    it('runs unit specs without the database flag', () => {
      const run = buildScopedRun(['src/a.spec.ts'], ['src/a.spec.ts']);
      expect(run.env.KODA_DB_TESTS).toBeUndefined();
      expect(run.args).toEqual(['jest', 'src/a.spec.ts', '--forceExit', '--passWithNoTests']);
    });

    it('sets KODA_DB_TESTS=1 and keeps integration specs when a DB-gated spec is targeted', () => {
      const target = 'test/integration/x.integration.spec.ts';
      const run = buildScopedRun([target], [target]);
      expect(run.env.KODA_DB_TESTS).toBe('1');
      expect(run.args).toEqual(['jest', target, '--forceExit', '--passWithNoTests']);
      expect(run.args.join(' ')).not.toContain('testPathIgnorePatterns');
    });

    it('decides DB mode from the expanded spec list, not the raw target', () => {
      const run = buildScopedRun(['test/'], ['test/unit/a.spec.ts', 'test/integration/b.integration.spec.ts']);
      expect(run.env.KODA_DB_TESTS).toBe('1');
      expect(run.args).toEqual(['jest', 'test/', '--forceExit', '--passWithNoTests']);
    });

    it('falls back to the unit suite when no target is given', () => {
      const run = buildScopedRun([], []);
      expect(run.env.KODA_DB_TESTS).toBeUndefined();
      expect(run.args).toEqual([
        'jest',
        '--forceExit',
        '--passWithNoTests',
        '--testPathIgnorePatterns=integration',
        '--testPathIgnorePatterns=e2e',
      ]);
    });
  });

  describe('expandTargets', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-scoped-'));
      fs.mkdirSync(path.join(dir, 'integration'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'a.spec.ts'), '');
      fs.writeFileSync(path.join(dir, 'integration', 'b.integration.spec.ts'), '');
      fs.writeFileSync(path.join(dir, 'integration', 'notes.md'), '');
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lists spec files under a directory target', () => {
      const expanded = expandTargets([dir]).map((p) => path.relative(dir, p)).sort();
      expect(expanded).toEqual(['a.spec.ts', path.join('integration', 'b.integration.spec.ts')]);
    });

    it('keeps an existing file target as given', () => {
      const file = path.join(dir, 'a.spec.ts');
      expect(expandTargets([file])).toEqual([file]);
    });
  });

  describe('hasUnresolvedTarget', () => {
    it('is true when a target is not an existing path (name pattern or renamed file)', () => {
      expect(hasUnresolvedTarget(['tenancy'])).toBe(true);
    });

    it('does not count a jest flag as an unresolved target', () => {
      expect(hasUnresolvedTarget([__filename, '--runInBand'])).toBe(false);
    });

    it('is false when every target exists', () => {
      expect(hasUnresolvedTarget([__filename])).toBe(false);
    });
  });

  describe('buildScopedRun with an unresolved target', () => {
    it('turns DB mode on so matched integration specs cannot skip silently', () => {
      const run = buildScopedRun(['tenancy'], ['tenancy'], true);
      expect(run.env.KODA_DB_TESTS).toBe('1');
    });
  });
});
