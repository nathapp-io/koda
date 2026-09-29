import { createVerify, generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { GitHubAppClient } from './github-app-client';
import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
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
    client = new GitHubAppClient(fleetCfg as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never));
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

  it('reports github_app_not_configured when the key file is unset', async () => {
    const bare = new GitHubAppClient({ ...fleetCfg, githubAppPrivateKeyFile: undefined } as never, { githubApiUrl: forge.url } as never, new FleetHttpClient(fleetCfg as never));
    await expect(bare.verifyRepo('o', 'r')).rejects.toMatchObject({ reason: 'github_app_not_configured' });
  });
});
