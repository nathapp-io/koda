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
});
