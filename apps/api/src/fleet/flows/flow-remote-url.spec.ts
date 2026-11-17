import { ValidationAppException } from '@nathapp/nestjs-common';
import { describe, expect, it } from 'vitest';
import { parseFlowInput } from './flow-input';
import { parseFlowRemoteUrl } from './flow-remote-url';

const naxInput = (remoteUrl: string) => ({
  features: [{ feature: 'flow-a', specPath: '.nax/features/flow-a/spec.md' }],
  roles: { reviewer: 'acp:claude', supervisor: 'native:fast' },
  costCapUsd: 25,
  remoteUrl,
  branch: 'feat/flow-a',
  specSha: 'a'.repeat(40),
});

/** What the call threw, so a call that returns instead of throwing fails its own assertion. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

function expectUnsupportedHost(fn: () => unknown): void {
  const error = thrownBy(fn);
  expect(error).toBeInstanceOf(ValidationAppException);
  expect((error as ValidationAppException).prefix).toBe('skills.unsupportedHost');
}

describe('parseFlowRemoteUrl', () => {
  it('AC-1 parses canonical GitHub remotes', () => {
    expect(parseFlowRemoteUrl('https://github.com/Org/Repo.git')).toEqual({ provider: 'github', owner: 'org', name: 'repo' });
  });

  it('AC-2 parses case-insensitive GitLab namespace paths and suffixes', () => {
    expect(parseFlowRemoteUrl('https://GitLab.example.com/Grp/Sub/App.git/')).toEqual({ provider: 'gitlab', url: 'https://gitlab.example.com/grp/sub/app' });
  });

  it('AC-3 rejects non-HTTPS GitLab remotes with unsupportedHost', () => {
    expectUnsupportedHost(() => parseFlowRemoteUrl('http://gitlab.com/grp/app'));
  });

  it('AC-4 rejects URLs containing credentials with unsupportedHost', () => {
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://user:pw@gitlab.com/grp/app'));
  });

  it('AC-5 does not reinterpret invalid GitHub paths as GitLab', () => {
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://github.com/org/repo/tree/main'));
  });

  it('AC-6 requires at least two remaining path segments', () => {
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://gitlab.com/app.git'));
  });

  it('refuses a GitLab path with a dot or an empty segment instead of following URL canonicalization', () => {
    // `new URL` folds `/grp/../app` to `/app`, which would read as a different repository: the path
    // is taken from the supplied string, so the traversal is refused rather than silently accepted.
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://gitlab.com/grp/../app'));
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://gitlab.com/grp/./app'));
    expectUnsupportedHost(() => parseFlowRemoteUrl('https://gitlab.com/grp//app'));
  });

  it('strips one trailing .git case-insensitively and no more', () => {
    expect(parseFlowRemoteUrl('https://gitlab.com/grp/app.GIT')).toEqual({ provider: 'gitlab', url: 'https://gitlab.com/grp/app' });
    expect(parseFlowRemoteUrl('https://gitlab.com/grp/app.git.git')).toEqual({ provider: 'gitlab', url: 'https://gitlab.com/grp/app.git' });
  });
});

describe('parseFlowInput remote URL check', () => {
  it('AC-7 accepts a GitLab remote and keeps the submitted string as remoteUrl', () => {
    expect(parseFlowInput(naxInput('https://gitlab.com/grp/app.git'), 'NAX').remoteUrl).toBe('https://gitlab.com/grp/app.git');
  });

  it('AC-8 reports an ssh remote against the remoteUrl property', () => {
    const error = thrownBy(() => parseFlowInput(naxInput('git@gitlab.com:grp/app.git'), 'NAX'));
    expect(error).toBeInstanceOf(ValidationAppException);
    expect((error as { args: { reason: string } }).args.reason).toBe('remoteUrl');
  });
});
