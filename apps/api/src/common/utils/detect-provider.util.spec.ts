/// <reference types="jest" />

import { detectProvider } from './detect-provider.util';

describe('detectProvider', () => {
  it('detects GitHub PR URLs', () => {
    const result = detectProvider('https://github.com/owner/repo/pull/42');
    expect(result).toEqual({
      provider: 'github',
      externalRef: 'owner/repo#42',
    });
  });

  it('detects GitLab MR URLs', () => {
    const result = detectProvider('https://gitlab.com/owner/repo/-/merge_requests/7');
    expect(result).toEqual({
      provider: 'gitlab',
      externalRef: 'owner/repo#7',
    });
  });

  it('detects Bitbucket PR URLs', () => {
    const result = detectProvider(
      'https://bitbucket.org/owner/repo/pull-requests/3',
    );
    expect(result).toEqual({
      provider: 'bitbucket',
      externalRef: 'owner/repo#3',
    });
  });

  it('returns other provider for unknown URLs', () => {
    const result = detectProvider('https://example.com/anything');
    expect(result).toEqual({
      provider: 'other',
      externalRef: null,
    });
  });

  it('returns other provider for malformed URLs without throwing', () => {
    const result = detectProvider('not-a-url');
    expect(result).toEqual({
      provider: 'other',
      externalRef: null,
    });
  });

  it('returns other provider for empty string without throwing', () => {
    const result = detectProvider('');
    expect(result).toEqual({
      provider: 'other',
      externalRef: null,
    });
  });

  it('handles GitHub URLs with trailing slashes', () => {
    const result = detectProvider('https://github.com/owner/repo/pull/42/');
    expect(result).toEqual({
      provider: 'github',
      externalRef: 'owner/repo#42',
    });
  });

  it('handles GitLab URLs with leading www', () => {
    const result = detectProvider(
      'https://www.gitlab.com/owner/repo/-/merge_requests/7',
    );
    expect(result).toEqual({
      provider: 'gitlab',
      externalRef: 'owner/repo#7',
    });
  });

  it('handles Bitbucket URLs with leading www', () => {
    const result = detectProvider(
      'https://www.bitbucket.org/owner/repo/pull-requests/3',
    );
    expect(result).toEqual({
      provider: 'bitbucket',
      externalRef: 'owner/repo#3',
    });
  });
});
