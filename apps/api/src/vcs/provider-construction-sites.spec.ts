/**
 * BUG-14: every VCS provider is built by providerForConnection, which derives
 * the repository URL and API base from the connection's provider. A direct
 * createVcsProvider call, or a hard-coded github.com repository URL, would send
 * a GitLab connection to GitHub.
 */
import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { sourceFiles } from '../common/test-helpers/source-files';

const SRC_ROOT = join(__dirname, '..');
const ALLOWED_FACTORY_CALLERS = new Set(['vcs/factory.ts', 'vcs/provider-for-connection.ts']);

const files = sourceFiles(SRC_ROOT).map((file) => ({
  path: relative(SRC_ROOT, file),
  source: readFileSync(file, 'utf8'),
}));

describe('VCS provider construction sites (BUG-14)', () => {
  it('only the factory and providerForConnection call createVcsProvider', () => {
    const offenders = files
      .filter((f) => /createVcsProvider\(/.test(f.source) && !ALLOWED_FACTORY_CALLERS.has(f.path))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('no source builds a github.com repository URL from a connection', () => {
    const offenders = files.filter((f) => /github\.com\/\$\{/.test(f.source)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
