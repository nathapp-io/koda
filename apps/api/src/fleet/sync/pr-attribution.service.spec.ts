import { prNumberFor } from './pr-attribution.service';

describe('prNumberFor (plan D19)', () => {
  const gh = { provider: 'github' as const, owner: 'acme', name: 'app' };
  const gl = { provider: 'gitlab' as const, owner: 'acme/platform', name: 'api' };

  it.each([
    [gh, 'https://github.com/acme/app/pull/12', 12],
    [gh, 'https://github.com/Acme/App/pull/12/', 12],
    [gh, 'https://ghe.acme.io/acme/app/pull/3', 3],
    [gl, 'https://gitlab.com/acme/platform/api/-/merge_requests/7', 7],
  ])('%o %s -> %s', (repo, url, n) => {
    expect(prNumberFor(repo, url)).toBe(n);
  });

  it.each([
    [gh, 'https://github.com/evil/app/pull/12'],
    [gh, 'https://github.com/acme/app/issues/12'],
    [gh, 'not a url'],
    [gl, 'https://gitlab.com/acme/other/api/-/merge_requests/7'],
    [gh, 'https://github.com/acme/app/pull/12x'],
  ])('refuses %o %s', (repo, url) => {
    expect(prNumberFor(repo, url)).toBeNull();
  });
});

describe('prNumberFor hostile input', () => {
  it('returns null when a URL path segment is undecodable (%E0%A4%A) instead of throwing', () => {
    expect(prNumberFor({ provider: 'github', owner: 'acme', name: 'app' }, 'https://github.com/%E0%A4%A/app/pull/12')).toBeNull();
  });
  it('returns null for a GitLab MR with an undecodable path segment', () => {
    expect(prNumberFor({ provider: 'gitlab', owner: 'acme', name: 'app' }, 'https://gitlab.example.com/%E0%A4%A/app/-/merge_requests/12')).toBeNull();
  });
});
