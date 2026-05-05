import * as fs from 'fs';
import * as path from 'path';

describe('Adversarial Review Findings — vcs-provider.ts', () => {
  const providerFilePath = path.resolve(__dirname, 'vcs-provider.ts');
  let providerSource: string;

  beforeAll(() => {
    providerSource = fs.readFileSync(providerFilePath, 'utf-8');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Bug 3: fetchCommitFiles interface does not include repoId.
  //
  // Spec-correct behavior:
  //   The IVcsProvider.fetchCommitFiles method signature must accept repoId
  //   as an explicit parameter. Currently the interface only takes
  //   (commitHash, changedFiles), which means callers have to smuggle repo
  //   identity through the opaque VcsProviderConfig object. A caller reading
  //   the interface has no way to know that repoId is required.
  // ──────────────────────────────────────────────────────────────────────────
  describe('Bug 3: fetchCommitFiles interface contract', () => {
    it('should include repoId as a parameter in fetchCommitFiles', () => {
      const methodMatch = providerSource.match(/fetchCommitFiles\(([^)]*)\)/);
      expect(methodMatch).toBeTruthy();

      const params = methodMatch?.[1];
      expect(params).toContain('repoId');
    });

    it('should list repoId before commitHash so callers understand the full contract', () => {
      const methodMatch = providerSource.match(/fetchCommitFiles\(([^)]*)\)/);
      expect(methodMatch).toBeTruthy();

      const params = methodMatch?.[1]?.trim();
      expect(params).toMatch(/^repoId/);
    });
  });
});
