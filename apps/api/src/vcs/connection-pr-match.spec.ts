import { linkMatchesConnection } from './connection-pr-match';

const repo = { repoOwner: 'Acme', repoName: 'App' };
const link = (externalRef: string | null, prNumber: number | null = 5, source?: string) => ({ externalRef, prNumber, source });

describe('linkMatchesConnection (C9 §3.6, D458)', () => {
  it('matches the connection repo case-insensitively', () => {
    expect(linkMatchesConnection(link('acme/app#5'), repo)).toBe(true);
  });

  it('rejects another repo with the same PR number', () => {
    expect(linkMatchesConnection(link('owner2/repo2#5'), repo)).toBe(false);
  });

  it('rejects a ref whose number is not the link prNumber', () => {
    expect(linkMatchesConnection(link('acme/app#6'), repo)).toBe(false);
  });

  it('matches a legacy null-ref vcs row by number only (source missing means vcs)', () => {
    expect(linkMatchesConnection(link(null), repo)).toBe(true);
    expect(linkMatchesConnection(link(null, 5, 'vcs'), repo)).toBe(true);
  });

  it('never matches a null-ref fleet row', () => {
    expect(linkMatchesConnection(link(null, 5, 'fleet'), repo)).toBe(false);
  });

  it('matches a GitLab nested-group repo', () => {
    expect(linkMatchesConnection(link('grp/sub/app#5'), { repoOwner: 'grp/sub', repoName: 'app' })).toBe(true);
  });

  it('rejects a ref that is not owner/repo#N', () => {
    expect(linkMatchesConnection(link('feature-branch'), repo)).toBe(false);
  });
});
