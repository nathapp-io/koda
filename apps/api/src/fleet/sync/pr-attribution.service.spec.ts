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
