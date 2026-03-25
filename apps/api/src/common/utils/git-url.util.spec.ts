/// <reference types="jest" />

import { buildGitUrl } from './git-url.util';

describe('buildGitUrl', () => {
  it('builds GitHub URL with line number', () => {
    const result = buildGitUrl(
      'https://github.com/nathapp-io/koda',
      'v1.0',
      'apps/api/src/auth.ts',
      42,
    );
    expect(result).toBe(
      'https://github.com/nathapp-io/koda/blob/v1.0/apps/api/src/auth.ts#L42',
    );
  });

  it('builds GitHub URL without line number', () => {
    const result = buildGitUrl(
      'https://github.com/nathapp-io/koda',
      'main',
      'apps/api/src/auth.ts',
    );
    expect(result).toBe(
      'https://github.com/nathapp-io/koda/blob/main/apps/api/src/auth.ts',
    );
  });

  it('builds GitLab URL with line number', () => {
    const result = buildGitUrl(
      'https://gitlab.com/nathapp/koda',
      'v1.0',
      'apps/api/src/auth.ts',
      42,
    );
    expect(result).toBe(
      'https://gitlab.com/nathapp/koda/-/blob/v1.0/apps/api/src/auth.ts#L42',
    );
  });

  it('builds GitLab URL without line number', () => {
    const result = buildGitUrl(
      'https://gitlab.com/nathapp/koda',
      'main',
      'apps/api/src/auth.ts',
    );
    expect(result).toBe(
      'https://gitlab.com/nathapp/koda/-/blob/main/apps/api/src/auth.ts',
    );
  });

  it('normalises URL with trailing .git', () => {
    const result = buildGitUrl(
      'https://github.com/nathapp-io/koda.git',
      'v1.0',
      'apps/api/src/auth.ts',
      42,
    );
    expect(result).toBe(
      'https://github.com/nathapp-io/koda/blob/v1.0/apps/api/src/auth.ts#L42',
    );
  });

  it('normalises URL with trailing slash', () => {
    const result = buildGitUrl(
      'https://github.com/nathapp-io/koda/',
      'v1.0',
      'apps/api/src/auth.ts',
      42,
    );
    expect(result).toBe(
      'https://github.com/nathapp-io/koda/blob/v1.0/apps/api/src/auth.ts#L42',
    );
  });

  it('returns null for null gitRemoteUrl', () => {
    const result = buildGitUrl(null, 'main', 'apps/api/src/auth.ts');
    expect(result).toBeNull();
  });

  it('returns null for undefined gitRemoteUrl', () => {
    const result = buildGitUrl(undefined, 'main', 'apps/api/src/auth.ts');
    expect(result).toBeNull();
  });
});