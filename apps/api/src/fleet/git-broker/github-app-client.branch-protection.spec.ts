import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubAppClient } from './github-app-client';
import type { FleetHttpClient } from './fleet-http-client';
import type { GitTokenBroker } from './git-token.broker';

const keyDir = mkdtempSync(join(tmpdir(), 'koda-review-token-'));
const keyFile = join(keyDir, 'app.pem');
writeFileSync(keyFile, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

describe('GitHub review tokens and branch protection', () => {
  const request = vi.fn();
  const client = new GitHubAppClient(
    { githubAppId: '42', githubAppPrivateKeyFile: keyFile, githubAppSlug: 'koda' } as never,
    { githubApiUrl: 'https://github.test' } as never,
    { request } as unknown as FleetHttpClient,
    { mint: vi.fn() } as unknown as GitTokenBroker,
  );
  beforeEach(() => request.mockReset());

  it('AC-1/2: mints review permissions and returns token expiry', async () => {
    request.mockResolvedValue({ status: 201, body: { token: 'review-token', expires_at: '2026-11-01T01:00:00Z' } });
    await expect(client.mintReviewToken(42n, 'app')).resolves.toEqual({ token: 'review-token', expiresAt: new Date('2026-11-01T01:00:00Z') });
    expect(request).toHaveBeenCalledWith('POST', 'https://github.test/app/installations/42/access_tokens', expect.objectContaining({ authorization: expect.stringMatching(/^Bearer /) }), {
      repositories: ['app'], permissions: { contents: 'read', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'read' },
    });
  });

  it.each([403, 422])('AC-3/11: maps mint status %s to app_permissions_insufficient', async (status) => {
    request.mockResolvedValue({ status, body: {} });
    await expect(client.mintReviewToken(42n, 'app')).rejects.toMatchObject({ reason: 'app_permissions_insufficient' });
  });

  it('AC-13/14: retains existing write and read-only grants', async () => {
    request.mockResolvedValue({ status: 201, body: { token: 't', expires_at: '2026-11-01T01:00:00Z' } });
    await client.mintInstallationToken(42n, 'app');
    expect(request.mock.calls[0][3]).toEqual({ repositories: ['app'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read', checks: 'read', statuses: 'read', actions: 'read' } });
    await client.mintReadOnlyToken(42n, 'app');
    expect(request.mock.calls[1][3]).toEqual({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } });
  });

  it.each(['pull_request', 'update'])('AC-4/5: recognizes %s branch rules', async (type) => {
    request.mockResolvedValueOnce({ status: 200, body: [{ type }] });
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]).toBe('https://github.test/repos/acme/app/rules/branches/main?per_page=100');
  });

  it('AC-6: recognizes classic branch protection if rules do not apply', async () => {
    request.mockResolvedValueOnce({ status: 200, body: [] }).mockResolvedValueOnce({ status: 200, body: { protected: true } });
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(true);
  });

  it('AC-7: returns false only when both successful endpoints show no supported protection', async () => {
    request.mockResolvedValueOnce({ status: 200, body: [{ type: 'required_status_checks' }] }).mockResolvedValueOnce({ status: 200, body: { protected: false } });
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(false);
  });

  it('AC-1: falls through plan-upgrade ruleset denial to an unprotected classic branch', async () => {
    request.mockResolvedValueOnce({ status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } });
    request.mockResolvedValueOnce({ status: 200, body: { protected: false } });

    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(false);
  });

  it('AC-2: falls through plan-upgrade ruleset denial to a protected classic branch', async () => {
    request.mockResolvedValueOnce({ status: 403, body: { message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' } });
    request.mockResolvedValueOnce({ status: 200, body: { protected: true } });

    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(true);
  });

  it('AC-3: falls through a missing rules endpoint to the classic branch endpoint', async () => {
    request.mockResolvedValueOnce({ status: 404, body: {} });
    request.mockResolvedValueOnce({ status: 200, body: { protected: false } });

    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).resolves.toBe(false);
  });

  it('AC-4: requests the classic branch endpoint after a plan-upgrade denial', async () => {
    request.mockResolvedValueOnce({ status: 403, body: { message: 'Please upgrade to GitHub Pro.' } });
    request.mockResolvedValueOnce({ status: 200, body: { protected: false } });

    await client.isBranchProtected('t', 'acme', 'app', 'main');

    expect(request.mock.calls[1][0]).toBe('GET');
    expect(request.mock.calls[1][1]).toBe('https://github.test/repos/acme/app/branches/main');
  });

  it('AC-5/6: fails closed on a non-plan ruleset denial without probing classic protection', async () => {
    request.mockResolvedValueOnce({ status: 403, body: { message: 'Resource not accessible by integration' } });

    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).rejects.toMatchObject({ reason: 'provider_error' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('AC-7: still fails closed when classic protection is unavailable after plan-upgrade denial', async () => {
    request.mockResolvedValueOnce({ status: 403, body: { message: 'Upgrade to GitHub Pro.' } });
    request.mockResolvedValueOnce({ status: 404, body: {} });

    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).rejects.toMatchObject({ reason: 'provider_error' });
  });

  it('AC-8: fails closed for ruleset server errors and network errors', async () => {
    request.mockResolvedValueOnce({ status: 500, body: [] });
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).rejects.toMatchObject({ reason: 'provider_error' });

    request.mockReset();
    request.mockRejectedValueOnce(new Error('network'));
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).rejects.toMatchObject({ reason: 'provider_error' });
  });

  it('AC-10: encodes branch slashes in the rules request', async () => {
    request.mockResolvedValueOnce({ status: 200, body: [] }).mockResolvedValueOnce({ status: 200, body: { protected: true } });
    await client.isBranchProtected('t', 'acme', 'app', 'release/v2');
    expect(request.mock.calls.map((call) => call[1])).toEqual([
      'https://github.test/repos/acme/app/rules/branches/release%2Fv2?per_page=100',
      'https://github.test/repos/acme/app/branches/release%2Fv2',
    ]);
  });

  it.each([
    [{ status: 500, body: [] }],
    [{ status: 200, body: [] }, { status: 404, body: {} }],
    [new Error('network')],
    [{ status: 200, body: [] }, new Error('network')],
  ])('AC-8/9/12: fails closed for endpoint failure %j', async (...results) => {
    for (const result of results) request.mockImplementationOnce(() => result instanceof Error ? Promise.reject(result) : Promise.resolve(result));
    await expect(client.isBranchProtected('t', 'acme', 'app', 'main')).rejects.toMatchObject({ reason: 'provider_error' });
  });
});
