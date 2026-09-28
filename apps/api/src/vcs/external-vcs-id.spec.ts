import { externalVcsIdFor } from './external-vcs-id';

describe('externalVcsIdFor (M11)', () => {
  it('qualifies the issue number with the repository', () => {
    expect(externalVcsIdFor({ repoOwner: 'acme', repoName: 'widgets' }, 42)).toBe('acme/widgets#42');
  });

  it('keeps a GitLab subgroup path as the owner', () => {
    expect(externalVcsIdFor({ repoOwner: 'group/sub', repoName: 'app' }, 3)).toBe('group/sub/app#3');
  });
});
