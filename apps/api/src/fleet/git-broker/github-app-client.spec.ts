import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubAppClient } from './github-app-client';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { GitTokenBroker } from './git-token.broker';
import type { FleetRepoRef } from '../jobs/domain/fleet-job.domain';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));

const b64json = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

describe('GitHubAppClient', () => {
  let forge: FakeForge;
  let client: GitHubAppClient;
  const fleetCfg = { githubAppId: '4242', githubAppPrivateKeyFile: keyFile, githubAppSlug: 'koda-fleet', httpTimeoutMs: 2000 };

  beforeAll(async () => {
    forge = await startFakeForge();
    client = new GitHubAppClient(fleetCfg as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never), { mint: jest.fn() } as unknown as GitTokenBroker);
  });
  afterAll(() => forge.close());
  beforeEach(() => {
    forge.routes.clear();
    forge.requests.length = 0;
  });

  it('signs an RS256 App JWT with iss = app id and a <= 10 min lifetime', () => {
    const jwt = client.createAppJwt(new Date('2026-09-30T00:00:00Z'));
    const [h, p, s] = jwt.split('.');
    expect(b64json(h)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = b64json(p);
    expect(payload.iss).toBe('4242');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('returns the canonical repo and installation id, minting a repo-scoped token', async () => {
    forge.routes.set('GET /repos/Acme/App/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_x', expires_at: '2026-09-30T01:00:00Z' } }));
    forge.routes.set('GET /repos/Acme/App', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));

    await expect(client.verifyRepo('Acme', 'App')).resolves.toEqual({ owner: 'acme', name: 'app', defaultBranch: 'trunk', installationId: BigInt(77) });
    const mint = forge.requests.find((r) => r.path === '/app/installations/77/access_tokens');
    expect(mint?.body).toEqual({ repositories: ['App'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
    expect(forge.requests.find((r) => r.path === '/repos/Acme/App')?.headers.authorization).toBe('Bearer ghs_x');
  });

  it('checks access through the persisted installation id without rediscovering the current installation', async () => {
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_old', expires_at: '2026-09-30T01:00:00Z' } }));
    forge.routes.set('GET /repos/Acme/App', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));

    await expect(client.verifyRepo('Acme', 'App', BigInt(77))).resolves.toMatchObject({ installationId: BigInt(77) });
    expect(forge.requests.some((r) => r.path === '/repos/Acme/App/installation')).toBe(false);
    expect(forge.requests.find((r) => r.path === '/app/installations/77/access_tokens')).toBeDefined();
    expect(forge.requests.find((r) => r.path === '/repos/Acme/App')?.headers.authorization).toBe('Bearer ghs_old');
  });

  it('reports an unreachable persisted installation when its token endpoint returns 404', async () => {
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 404, body: {} }));
    await expect(client.verifyRepo('Acme', 'App', BigInt(77))).rejects.toMatchObject({ reason: 'app_not_installed' });
  });

  it.each([
    ['GET /repos/o/r/installation', 404, 'app_not_installed'],
    ['GET /repos/o/r/installation', 500, 'provider_error'],
  ])('maps %s -> %s to %s', async (route, status, reason) => {
    forge.routes.set(route, () => ({ status, body: { message: 'secret provider detail' } }));
    await expect(client.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: reason });
  });

  it('maps a refused permission set to app_permissions_insufficient', async () => {
    forge.routes.set('GET /repos/o/r/installation', () => ({ status: 200, body: { id: 1 } }));
    forge.routes.set('POST /app/installations/1/access_tokens', () => ({ status: 422, body: {} }));
    await expect(client.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'app_permissions_insufficient' });
  });

  it('mints a repo-scoped installation token with its expiry', async () => {
    forge.routes.set('POST /app/installations/77/access_tokens', (req) => {
      expect(req.body).toEqual({ repositories: ['app'], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
      return { status: 201, body: { token: 'ghs_x', expires_at: '2026-10-01T01:00:00Z' } };
    });
    await expect(client.mintInstallationToken(BigInt(77), 'app')).resolves.toEqual({ token: 'ghs_x', expiresAt: new Date('2026-10-01T01:00:00Z') });
    forge.routes.set('POST /app/installations/78/access_tokens', () => ({ status: 404, body: {} }));
    await expect(client.mintInstallationToken(BigInt(78), 'app')).rejects.toMatchObject({ reason: 'app_not_installed' });
  });

  it('reports github_app_not_configured when the key file is unset', async () => {
    const bare = new GitHubAppClient({ ...fleetCfg, githubAppPrivateKeyFile: undefined } as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never), { mint: jest.fn() } as unknown as GitTokenBroker);
    await expect(bare.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'github_app_not_configured' });
  });

  it('reports github_app_key_unreadable when the key file cannot be read', async () => {
    const broken = new GitHubAppClient({ ...fleetCfg, githubAppPrivateKeyFile: join(tmpdir(), 'koda-gh-app-missing', 'app.pem') } as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never), { mint: jest.fn() } as unknown as GitTokenBroker);
    await expect(broken.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'github_app_key_unreadable' });
  });

  describe('getPullRequest (C9 §3.4)', () => {
    const PR = 'GET /repos/acme/app/pulls/9';

    it('maps a merged PR and sends the given token', async () => {
      forge.routes.set(PR, () => ({
        status: 200,
        body: {
          state: 'closed', draft: false, merged: true, merged_at: '2026-10-06T01:02:03Z', merged_by: { login: 'dev' },
          merge_commit_sha: 'abc123', html_url: 'https://github.com/acme/app/pull/9', title: 'Fix it',
        },
      }));
      await expect(client.getPullRequest('ghs_tok', 'acme', 'app', 9)).resolves.toEqual({
        number: 9, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-06T01:02:03Z'), mergedBy: 'dev',
        mergeSha: 'abc123', url: 'https://github.com/acme/app/pull/9', title: 'Fix it',
      });
      expect(forge.requests[0].headers.authorization).toBe('Bearer ghs_tok');
    });

    it('maps an open draft PR', async () => {
      forge.routes.set(PR, () => ({ status: 200, body: { state: 'open', draft: true, merged: false, merged_at: null, merged_by: null, html_url: 'u', title: 't' } }));
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).resolves.toEqual(expect.objectContaining({ state: 'open', draft: true, merged: false, mergedBy: null, mergeSha: null }));
    });

    it('returns null for 404', async () => {
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).resolves.toBeNull();
    });

    it.each([
      [{ status: 500, body: {} }],
      [{ status: 200, body: { draft: false } }],
    ])('throws provider_error for %j', async (reply) => {
      forge.routes.set(PR, () => reply);
      await expect(client.getPullRequest('t', 'acme', 'app', 9)).rejects.toMatchObject({ reason: 'provider_error' });
    });
  });
});

describe('commentOnPullRequest cache hit', () => {
  let forge: FakeForge;
  let vcsCfg: { githubApiUrl: string };
  let fleetHttp: FleetHttpClient;
  const fleetCfg = { githubAppId: '4242', githubAppPrivateKeyFile: keyFile, githubAppSlug: 'koda-fleet', httpTimeoutMs: 2000 };
  const repo: FleetRepoRef = {
    id: 'r1', projectId: 'p1', provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', githubInstallationId: 42n,
  };
  const farFuture = '2026-10-01T01:00:00.000Z';
  const cached = { jobId: 'j1', token: 'cached', username: 'x-access-token' as const, expiresAt: farFuture };

  beforeAll(async () => {
    forge = await startFakeForge();
    vcsCfg = { githubApiUrl: forge.url };
    fleetHttp = new FleetHttpClient(fleetCfg as never);
  });
  afterAll(() => forge.close());
  beforeEach(() => {
    forge.routes.clear();
    forge.requests.length = 0;
  });

  it('hits the broker cache instead of minting when jobId/leaseEpoch/repo are provided', async () => {
    forge.routes.set('POST /repos/acme/app/issues/7/comments', () => ({ status: 201, body: { id: 1 } }));
    const mint = jest.fn(async () => ({ ok: true as const, token: cached }));
    const broker = { mint } as unknown as GitTokenBroker;
    const client = new GitHubAppClient(fleetCfg as never, vcsCfg as never, fleetHttp, broker);
    await client.commentOnPullRequest(42n, 'acme', 'app', 7, 'body', { jobId: 'j1', leaseEpoch: 1, repo });
    expect(mint).toHaveBeenCalledWith({ jobId: 'j1', leaseEpoch: 1, repo }, expect.any(Date));
    expect(forge.requests.filter((r) => r.path.endsWith('/access_tokens'))).toHaveLength(0);
    const comment = forge.requests.find((r) => r.path === '/repos/acme/app/issues/7/comments');
    expect(comment?.headers.authorization).toBe('Bearer cached');
  });

  it('falls back to a fresh mint when no job context is provided', async () => {
    forge.routes.set('POST /app/installations/42/access_tokens', () => ({ status: 201, body: { token: 'ghs_fresh', expires_at: farFuture } }));
    forge.routes.set('POST /repos/acme/app/issues/7/comments', () => ({ status: 201, body: { id: 1 } }));
    const mint = jest.fn(async () => ({ ok: true as const, token: cached }));
    const broker = { mint } as unknown as GitTokenBroker;
    const client = new GitHubAppClient(fleetCfg as never, vcsCfg as never, fleetHttp, broker);
    await client.commentOnPullRequest(42n, 'acme', 'app', 7, 'body');
    expect(mint).not.toHaveBeenCalled();
    expect(forge.requests.filter((r) => r.path.endsWith('/access_tokens'))).toHaveLength(1);
    const comment = forge.requests.find((r) => r.path === '/repos/acme/app/issues/7/comments');
    expect(comment?.headers.authorization).toBe('Bearer ghs_fresh');
  });

  it('falls back to a fresh mint when only some opts are provided (no partial cache use)', async () => {
    forge.routes.set('POST /app/installations/42/access_tokens', () => ({ status: 201, body: { token: 'ghs_fresh', expires_at: farFuture } }));
    forge.routes.set('POST /repos/acme/app/issues/7/comments', () => ({ status: 201, body: { id: 1 } }));
    const mint = jest.fn(async () => ({ ok: true as const, token: cached }));
    const broker = { mint } as unknown as GitTokenBroker;
    const client = new GitHubAppClient(fleetCfg as never, vcsCfg as never, fleetHttp, broker);
    await client.commentOnPullRequest(42n, 'acme', 'app', 7, 'body', { jobId: 'j1' });
    expect(mint).not.toHaveBeenCalled();
    expect(forge.requests.filter((r) => r.path.endsWith('/access_tokens'))).toHaveLength(1);
  });
});
