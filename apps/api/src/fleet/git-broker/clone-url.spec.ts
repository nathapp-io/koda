import { cloneUrlFor, forgeWebBase } from './clone-url';

describe('clone urls', () => {
  it.each([
    ['https://api.github.com', 'https://github.com'],
    ['https://ghe.acme.io/api/v3', 'https://ghe.acme.io'],
    ['https://gitlab.com/api/v4', 'https://gitlab.com'],
    ['https://gitlab.acme.io/gitlab/api/v4/', 'https://gitlab.acme.io/gitlab'],
    ['http://127.0.0.1:4010', 'http://127.0.0.1:4010'],
  ])('%s -> %s', (api, web) => {
    expect(forgeWebBase(api)).toBe(web);
  });

  it('builds https clone urls, nested GitLab groups included', () => {
    const cfg = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };
    expect(cloneUrlFor({ provider: 'github', owner: 'acme', name: 'app' }, cfg)).toBe('https://github.com/acme/app.git');
    expect(cloneUrlFor({ provider: 'gitlab', owner: 'acme/platform', name: 'api' }, cfg)).toBe('https://gitlab.com/acme/platform/api.git');
  });

  /**
   * US-003: a GitLab repo is cloned from its own host, so a self-hosted instance (with its own path
   * prefix) and a nested group are addressed the way the instance stores them.
   */
  it('US-003 AC-6: builds a GitLab clone url from the repo host, path prefix and subgroup included', () => {
    const cfg = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };
    expect(cloneUrlFor({ provider: 'gitlab', host: 'https://gitlab.example.com/gl', owner: 'g/sub', name: 'app' }, cfg))
      .toBe('https://gitlab.example.com/gl/g/sub/app.git');
  });

  it('US-003 AC-7: falls back to the configured GitLab base when the repo carries no host', () => {
    const cfg = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };
    expect(cloneUrlFor({ provider: 'gitlab', owner: 'acme/platform', name: 'api' }, cfg)).toBe('https://gitlab.com/acme/platform/api.git');
    expect(cloneUrlFor({ provider: 'gitlab', host: '', owner: 'acme/platform', name: 'api' }, cfg)).toBe('https://gitlab.com/acme/platform/api.git');
  });

  it('US-003 AC-8: clones a GitHub repo from the configured GitHub base, whatever host it carries', () => {
    const cfg = { githubApiUrl: 'https://api.github.com', gitlabApiUrl: 'https://gitlab.com/api/v4' };
    expect(cloneUrlFor({ provider: 'github', host: 'https://gitlab.example.com', owner: 'acme', name: 'app' }, cfg))
      .toBe('https://github.com/acme/app.git');
  });
});
