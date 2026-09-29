import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  PathError, assertFeature, assertInside, assertOwner, assertRelativePath, assertSegment, featureDirFor, jobDirFor, repoDirFor,
} from './safe-segment';

describe('assertSegment', () => {
  test.each(['app', 'my.repo', 'a_b-c', '.github', 'x'.repeat(100)])('accepts %s', (v) => {
    expect(assertSegment('repo', v)).toBe(v);
  });
  test.each(['', '.', '..', 'a/b', 'a\\b', 'a b', 'a\u0000b', 'x'.repeat(101), '../etc', 'a%2fb', 'é'])('rejects %j', (v) => {
    expect(() => assertSegment('repo', v)).toThrow(PathError);
  });
  test('rejects non-strings', () => {
    for (const v of [undefined, null, 1, {}, []]) expect(() => assertSegment('repo', v)).toThrow(PathError);
  });
});

describe('assertOwner', () => {
  test('accepts a plain owner and a GitLab subgroup path', () => {
    expect(assertOwner('acme')).toBe('acme');
    expect(assertOwner('infra/deploy-team')).toBe('infra/deploy-team');
  });
  test.each(['.jobs', '.hidden/x', 'a//b', 'a/../b', '/a', 'a/', 'a/.'])('rejects %j (D29: no leading dot on the first segment, no empty or dot segments)', (v) => {
    expect(() => assertOwner(v)).toThrow(PathError);
  });
});

describe('assertFeature', () => {
  test.each(['feat', 'a.b-c_d', 'F1'])('accepts %s', (v) => expect(assertFeature(v)).toBe(v));
  test.each(['', '.x', '-x', '_x', 'a/b', 'a..b', 'x'.repeat(129)])('rejects %j (server FEATURE_RE)', (v) => {
    expect(() => assertFeature(v)).toThrow(PathError);
  });
});

describe('assertRelativePath', () => {
  test('accepts a repo-relative spec path', () => {
    expect(assertRelativePath('planFrom', 'docs/specs/SPEC-x.md')).toBe('docs/specs/SPEC-x.md');
  });
  test.each(['', '/etc/passwd', '-rf', 'a/../b', 'a//b', './a', 'a/.', 'a\\b', 'a\u0000b', 'x'.repeat(513)])('rejects %j', (v) => {
    expect(() => assertRelativePath('planFrom', v)).toThrow(PathError);
  });
});

describe('path builders', () => {
  const root = join('/', 'work', 'space');
  test('build under the workspace root', () => {
    expect(repoDirFor(root, 'Acme', 'app')).toBe(join(root, 'Acme', 'app'));
    expect(repoDirFor(root, 'infra/team', 'deploy')).toBe(join(root, 'infra', 'team', 'deploy'));
    expect(jobDirFor(root, 'cabc123')).toBe(join(root, '.jobs', 'cabc123'));
    expect(featureDirFor(join(root, 'Acme', 'app'), 'feat')).toBe(join(root, 'Acme', 'app', '.nax', 'features', 'feat'));
  });
  test('refuse hostile pieces', () => {
    expect(() => repoDirFor(root, '..', 'app')).toThrow(PathError);
    expect(() => repoDirFor(root, 'acme', '..')).toThrow(PathError);
    expect(() => repoDirFor(root, '.jobs', 'x')).toThrow(PathError);
    expect(() => jobDirFor(root, '../x')).toThrow(PathError);
    expect(() => featureDirFor(root, 'a/b')).toThrow(PathError);
  });
  test('assertInside accepts a strict descendant only', () => {
    expect(assertInside(root, join(root, 'a', 'b'))).toBe(join(root, 'a', 'b'));
    expect(() => assertInside(root, root)).toThrow(PathError);
    expect(() => assertInside(root, join(root, '..', 'other'))).toThrow(PathError);
    expect(() => assertInside(root, join('/', 'work', 'space-evil', 'x'))).toThrow(PathError);
  });
});
