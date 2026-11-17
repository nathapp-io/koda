import { gitLabRemoteIdentities } from './gitlab-remote-identity';

describe('gitlabRemoteIdentities', () => {
  it('names the host, the namespace and the name of a remote', () => {
    expect(gitLabRemoteIdentities('https://gitlab.com/grp/app')).toEqual([
      { host: 'https://gitlab.com', owner: 'grp', name: 'app' },
    ]);
  });

  it('names every split of a remote whose host carries a path prefix', () => {
    expect(gitLabRemoteIdentities('https://example.com/gitlab/grp/app')).toEqual([
      { host: 'https://example.com', owner: 'gitlab/grp', name: 'app' },
      { host: 'https://example.com/gitlab', owner: 'grp', name: 'app' },
    ]);
  });

  it('keeps a namespace that carries slashes of its own', () => {
    expect(gitLabRemoteIdentities('https://gitlab.example.com/grp/sub/app')).toEqual([
      { host: 'https://gitlab.example.com', owner: 'grp/sub', name: 'app' },
      { host: 'https://gitlab.example.com/grp', owner: 'sub', name: 'app' },
    ]);
  });

  it('keeps the port of a self-hosted instance', () => {
    expect(gitLabRemoteIdentities('https://git.corp.example:8443/grp/app')).toEqual([
      { host: 'https://git.corp.example:8443', owner: 'grp', name: 'app' },
    ]);
  });

  it.each([
    ['a string that is not a URL', 'not a url'],
    ['a plain http remote', 'http://gitlab.com/grp/app'],
    ['a remote with credentials', 'https://user:pw@gitlab.com/grp/app'],
    ['a remote with a query', 'https://gitlab.com/grp/app?x=1'],
    ['a remote with a fragment', 'https://gitlab.com/grp/app#head'],
    ['a remote with one segment', 'https://gitlab.com/app'],
    ['a remote with an empty segment', 'https://gitlab.com/grp//app'],
    ['a remote with a trailing slash', 'https://gitlab.com/grp/app/'],
  ])('names no identity for %s', (_case, url) => {
    expect(gitLabRemoteIdentities(url)).toEqual([]);
  });
});
