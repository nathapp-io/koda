import { isIP } from 'node:net';
import { assertGitLabHostAllowed, isClassifiableGitLabHost, parseGitLabHost } from './gitlab-host';
import { RepoCheckException } from './repo-check.exception';

/**
 * US-002 (GitLab parity F1): the host rule of owner decision A.
 *
 * `dns.lookup` is stubbed, so the address verdicts are the ones under test — never a real
 * resolution. The production checks stay strict: the stub only replaces the resolver.
 */
const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('node:dns', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:dns')>();
  return { ...original, promises: { ...original.promises, lookup: lookupMock } };
});

/** The addresses a stubbed lookup answers with. */
const answers = (...addresses: string[]): void => {
  lookupMock.mockResolvedValue(addresses.map((address) => ({ address, family: isIP(address) })));
};

beforeEach(() => {
  lookupMock.mockReset();
  answers('192.168.1.20');
});

describe('parseGitLabHost', () => {
  it('AC-1: canonicalises the scheme, the host, the port and the path prefix', () => {
    expect(parseGitLabHost('HTTPS://GitLab.Example.com:8443/gl/')).toBe('https://gitlab.example.com:8443/gl');
  });

  it.each([
    ['a plain host', 'https://gitlab.example.com', 'https://gitlab.example.com'],
    ['a trailing slash', 'https://gitlab.example.com/', 'https://gitlab.example.com'],
    ['the default port', 'https://gitlab.example.com:443/', 'https://gitlab.example.com'],
    ['a deeper path prefix', 'https://gitlab.example.com/gl/sub/', 'https://gitlab.example.com/gl/sub'],
    ['surrounding spaces', '  https://gitlab.example.com  ', 'https://gitlab.example.com'],
  ])('AC-1: %s keeps its canonical form', (_label, input, expected) => {
    expect(parseGitLabHost(input)).toBe(expected);
  });

  it('AC-1: an absent host means gitlab.com', () => {
    expect(parseGitLabHost('')).toBe('https://gitlab.com');
  });

  it.each([
    ['a plain http scheme', 'http://gitlab.example.com'],
    ['a userinfo', 'https://user@gitlab.example.com'],
    ['a query', 'https://gitlab.example.com/?a=1'],
    ['a fragment', 'https://gitlab.example.com/#x'],
    ['no scheme at all', 'gitlab.example.com'],
    ['an unparseable value', 'not a host'],
  ])('AC-2: refuses %s', (_label, input) => {
    expect(() => parseGitLabHost(input)).toThrow(RepoCheckException);
    expect(() => parseGitLabHost(input)).toThrow(expect.objectContaining({ reason: 'gitlab_host_invalid' }));
  });
});

describe('isClassifiableGitLabHost', () => {
  it('AC-3: is true for a host whose name carries gitlab', () => {
    expect(isClassifiableGitLabHost('https://gitlab.corp.example')).toBe(true);
  });

  it('AC-3: is false for a host without gitlab in its name', () => {
    expect(isClassifiableGitLabHost('https://git.corp.example')).toBe(false);
  });

  it('reads the host name, not the path', () => {
    expect(isClassifiableGitLabHost('https://git.corp.example/gitlab')).toBe(false);
    expect(isClassifiableGitLabHost('https://GITLAB.corp.example')).toBe(true);
  });
});

describe('assertGitLabHostAllowed', () => {
  it('AC-4: resolves for an address inside an allowed subnet', async () => {
    answers('192.168.1.20');
    await expect(assertGitLabHostAllowed('https://gitlab.lan')).resolves.toBeUndefined();
    expect(lookupMock).toHaveBeenCalledWith('gitlab.lan', { all: true });
  });

  it.each([
    ['loopback', '127.0.0.1'],
    ['the link-local metadata address', '169.254.169.254'],
    ['the mapped metadata address', '::ffff:169.254.169.254'],
    ['the CGNAT address', '100.100.100.200'],
    ['the IPv6 metadata address', 'fd00:ec2::254'],
  ])('AC-5: refuses %s', async (_label, address) => {
    answers(address);
    await expect(assertGitLabHostAllowed('https://gitlab.lan')).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
  });

  it('AC-6: refuses when one of the addresses is blocked', async () => {
    answers('192.168.1.20', '169.254.169.254');
    await expect(assertGitLabHostAllowed('https://gitlab.lan')).rejects.toMatchObject({ reason: 'gitlab_host_blocked' });
  });

  it('AC-4: allows every address of an allowed answer', async () => {
    answers('192.168.1.20', '10.1.2.3');
    await expect(assertGitLabHostAllowed('https://gitlab.lan')).resolves.toBeUndefined();
  });

  it('answers provider_unreachable when the host does not resolve', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }));
    await expect(assertGitLabHostAllowed('https://gitlab.lan')).rejects.toMatchObject({ reason: 'provider_unreachable' });
  });
});
