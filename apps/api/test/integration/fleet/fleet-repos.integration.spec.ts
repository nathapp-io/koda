import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet S1 slice 1 — repo registration end to end, GitHub and GitLab faked locally (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-repos.integration.spec.ts
 */
import request from 'supertest';
import { promises as dns } from 'node:dns';
import { generateKeyPairSync } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, TEST_PASSWORD } from '../../helpers/http-app';
import { FakeForge, startFakeForge } from '../../helpers/fake-forge';
import { GitLabAccessChecker } from '../../../src/fleet/git-broker/gitlab-access-checker';
import { RepoCheckException } from '../../../src/fleet/git-broker/repo-check.exception';
import { expectGuardActive, fixtureDb } from '../../helpers/action-context';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENC_KEY = 'b'.repeat(64);
const ENV_KEYS = ['GITHUB_API_URL', 'VCS_GITLAB_API_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_APP_SLUG', 'VCS_ENCRYPTION_KEY'] as const;

describeIntegration('fleet repos (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let forge: FakeForge;
  let admin: string;
  let member: string;
  let dnsLookup: ReturnType<typeof vi.spyOn>;
  const saved: Record<string, string | undefined> = {};
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    // US-002: the GitLab client checks the host before every call, and the fake forge answers on
    // loopback — an address the check refuses. The resolver is stubbed (the check itself is not
    // relaxed): the fake forge still serves the calls.
    dnsLookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '192.168.1.20', family: 4 }] as never);
    forge = await startFakeForge();
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'gh-app-')), 'app.pem');
    writeFileSync(keyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }));
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      GITHUB_API_URL: forge.url, VCS_GITLAB_API_URL: `${forge.url}/api/v4`, GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_APP_SLUG: 'koda-fleet', VCS_ENCRYPTION_KEY: ENC_KEY,
    });

    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    admin = data<{ accessToken: string }>(
      await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
    ).accessToken;
    await request(server).post('/api/projects').set(auth(admin)).send({ name: 'Web', slug: 'web', key: 'WEB' }).expect(201);
    await request(server).post('/api/projects').set(auth(admin)).send({ name: 'Ops', slug: 'ops', key: 'OPS' }).expect(201);
    await request(server).post('/api/admin/users').set(auth(admin)).send({ email: 'm@koda.test', name: 'm', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    member = await loginToken(server, 'm@koda.test');
    await request(server).post('/api/projects/web/members').set(auth(admin)).send({ email: 'm@koda.test', roleKey: 'viewer' }).expect(201);

    forge.routes.set('GET /repos/Acme/App/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('POST /app/installations/77/access_tokens', () => ({ status: 201, body: { token: 'ghs_1', expires_at: '2099-01-01T00:00:00Z' } }));
    forge.routes.set('GET /repos/Acme/App', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));
    forge.routes.set('GET /repos/acme/app/installation', () => ({ status: 200, body: { id: 77 } }));
    forge.routes.set('GET /repos/acme/app', () => ({ status: 200, body: { name: 'app', owner: { login: 'acme' }, default_branch: 'trunk' } }));
  });

  afterAll(async () => {
    dnsLookup.mockRestore();
    await app.close();
    await forge.close();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('registers a GitHub repo under its canonical name; a second registration in any case is 409', async () => {
    const repo = data<{ owner: string; name: string; defaultBranch: string; githubInstallationId: string }>(
      await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'Acme', name: 'App' }).expect(201),
    );
    expect(repo).toEqual(expect.objectContaining({ owner: 'acme', name: 'app', defaultBranch: 'trunk', githubInstallationId: '77' }));
    await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' }).expect(409);
  });

  it('answers 422 with a reason when the App is not installed, and never echoes provider bodies', async () => {
    forge.routes.set('GET /repos/other/thing/installation', () => ({ status: 404, body: { message: 'provider-internal-detail' } }));
    const res = await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'other', name: 'thing' }).expect(422);
    expect(JSON.stringify(res.body)).toContain('app_not_installed');
    expect(JSON.stringify(res.body)).not.toContain('provider-internal-detail');
  });

  it('US-004: registers a GitLab repo with its own two tokens and stores them per repo', async () => {
    const prisma = fixtureDb(app);
    // The GitLab client is stubbed: the repo's host is gitlab.com, which the fake forge does not
    // serve. The verification calls themselves are the ones the registration makes.
    const checker = app.get(GitLabAccessChecker);
    const tokenSelf = vi.spyOn(checker, 'getTokenSelf').mockImplementation(async (_apiBase: string, token: string) => ({
      scopes: token === 'glpat-write' ? ['api', 'write_repository'] : ['read_api', 'read_repository'],
      expiresAt: token === 'glpat-write' ? new Date('2027-01-01T00:00:00.000Z') : new Date('2026-12-01T00:00:00.000Z'),
    }));
    const currentUser = vi.spyOn(checker, 'getCurrentUser').mockImplementation(async (_apiBase: string, token: string) =>
      (token === 'glpat-write'
        ? { id: 7, username: 'alice', bot: false }
        : { id: 8, username: 'koda-reader', bot: true }));
    const findProject = vi.spyOn(checker, 'findProject').mockResolvedValue({
      id: 42, owner: 'infra', name: 'deploy', defaultBranch: 'main', accessLevel: 30,
    });

    const created = data<{
      owner: string; name: string; defaultBranch: string; host: string;
      gitlab: {
        projectId: number; warnings: string[];
        readToken: { username: string; expiresAt: string | null };
        writeToken: { username: string; isBot: boolean; expiresAt: string | null };
      };
    }>(
      await request(server).post('/api/fleet/repos').set(auth(admin)).send({
        projectSlug: 'ops', provider: 'gitlab', owner: 'infra', name: 'deploy',
        readToken: 'glpat-read', writeToken: 'glpat-write',
      }).expect(201),
    );

    // AC-9: the row carries the canonical identity and the host the body named.
    const row = await prisma.fleetRepo.findFirstOrThrow({ where: { provider: 'gitlab', name: 'deploy' } });
    expect(row).toMatchObject({ owner: 'infra', name: 'deploy', defaultBranch: 'main', host: 'https://gitlab.com' });
    // AC-9: the credential row carries the identity and the expiry the verification found.
    const credential = await prisma.fleetRepoGitlabCredential.findFirstOrThrow({ where: { repoId: row.id } });
    expect(credential).toMatchObject({
      gitlabProjectId: 42, readTokenUsername: 'koda-reader', writeTokenUsername: 'alice', writeTokenIsBot: false,
      readTokenExpiresAt: new Date('2026-12-01T00:00:00.000Z'), writeTokenExpiresAt: new Date('2027-01-01T00:00:00.000Z'),
    });
    // AC-13: the answer carries the warnings of a human write token and no token itself.
    expect(created.gitlab).toMatchObject({
      projectId: 42,
      warnings: ['write_token_human'],
      readToken: { username: 'koda-reader', expiresAt: '2026-12-01T00:00:00.000Z' },
      writeToken: { username: 'alice', isBot: false, expiresAt: '2027-01-01T00:00:00.000Z' },
    });
    expect(created).not.toHaveProperty('readToken');
    expect(created).not.toHaveProperty('writeToken');

    // The tokens are stored encrypted: the row never holds a plaintext token.
    expect(credential.encryptedReadToken).not.toBe('glpat-read');
    expect(credential.encryptedWriteToken).not.toBe('glpat-write');

    tokenSelf.mockRestore();
    currentUser.mockRestore();
    findProject.mockRestore();
  });

  it('US-004: refuses a GitLab repo the read token cannot see', async () => {
    const prisma = fixtureDb(app);
    const checker = app.get(GitLabAccessChecker);
    const tokenSelf = vi.spyOn(checker, 'getTokenSelf').mockImplementation(async (_apiBase: string, token: string) => ({
      scopes: token === 'glpat-write' ? ['api', 'write_repository'] : ['read_api', 'read_repository'],
      expiresAt: null,
    }));
    const currentUser = vi.spyOn(checker, 'getCurrentUser').mockResolvedValue({ id: 7, username: 'alice', bot: false });
    const findProject = vi.spyOn(checker, 'findProject').mockImplementation(async (_apiBase: string, token: string) => {
      // The write token sees the project; the read token does not.
      if (token === 'glpat-read') throw new RepoCheckException('repo_not_found');
      return { id: 42, owner: 'infra', name: 'hidden', defaultBranch: 'main', accessLevel: 30 };
    });

    const res = await request(server).post('/api/fleet/repos').set(auth(admin)).send({
      projectSlug: 'ops', provider: 'gitlab', owner: 'infra', name: 'hidden',
      readToken: 'glpat-read', writeToken: 'glpat-write',
    }).expect(422);
    expect(JSON.stringify(res.body)).toContain('gitlab_read_token_no_access');
    expect(await prisma.fleetRepo.count({ where: { name: 'hidden' } })).toBe(0);

    tokenSelf.mockRestore();
    currentUser.mockRestore();
    findProject.mockRestore();
  });

  it('US-004 AC-1: refuses a GitHub repo that carries a GitLab field, and stores no row', async () => {
    const prisma = fixtureDb(app);
    const res = await request(server).post('/api/fleet/repos').set(auth(admin)).send({
      projectSlug: 'web', provider: 'github', owner: 'acme', name: 'tokened', readToken: 'glpat-read',
    }).expect(400);
    expect(res.body.message).toBe('A GitHub repository cannot carry GitLab fields: host, readToken, writeToken and confirmBotAccount belong to a GitLab repository');
    expect(await prisma.fleetRepo.count({ where: { name: 'tokened' } })).toBe(0);
  });

  it('US-004: a GitLab repo without its tokens is refused before any request', async () => {
    const prisma = fixtureDb(app);
    await request(server).post('/api/fleet/repos').set(auth(admin)).send({
      projectSlug: 'ops', provider: 'gitlab', owner: 'infra', name: 'untokened', readToken: 'glpat-read',
    }).expect(400);
    expect(await prisma.fleetRepo.count({ where: { name: 'untokened' } })).toBe(0);
  });

  it('shows project repos to members only, and admin routes to admins only', async () => {
    const page = data<{ records: Array<{ name: string }> }>(await request(server).get('/api/projects/web/fleet/repos').set(auth(member)).expect(200));
    expect(page.records.map((r) => r.name)).toEqual(['app']);
    await request(server).get('/api/projects/ops/fleet/repos').set(auth(member)).expect(403);
    await request(server).get('/api/fleet/repos').set(auth(member)).expect(403);
    await request(server).post('/api/fleet/repos').set(auth(member)).send({ projectSlug: 'web', provider: 'github', owner: 'acme', name: 'app' }).expect(403);
  });

  it('re-checks a registered repo on demand and reports a forge refusal as data (D119)', async () => {
    const all = data<{ records: Array<{ id: string; name: string }> }>(await request(server).get('/api/fleet/repos').set(auth(admin)).expect(200));
    const registered = all.records.find((r) => r.name === 'app') ?? data<{ id: string; name: string }>(
      await request(server).post('/api/fleet/repos').set(auth(admin)).send({ projectSlug: 'web', provider: 'github', owner: 'Acme', name: 'App' }).expect(201),
    );
    const ok = data<{ repoId: string; reachable: boolean; reason: string | null }>(
      await request(server).post(`/api/fleet/repos/${registered.id}/check`).set(auth(admin)).expect(200),
    );
    expect(ok).toEqual(expect.objectContaining({ repoId: registered.id, reachable: true, reason: null }));

    const discoveryRoute = 'GET /repos/acme/app/installation';
    const persistedMintRoute = 'POST /app/installations/77/access_tokens';
    const previousDiscovery = forge.routes.get(discoveryRoute);
    const previousMint = forge.routes.get(persistedMintRoute);
    const requestStart = forge.requests.length;
    try {
      // A newly discovered ID must not replace the installation ID saved at registration.
      forge.routes.set(discoveryRoute, () => ({ status: 200, body: { id: 99 } }));
      forge.routes.set(persistedMintRoute, () => ({ status: 404, body: { message: 'provider-internal-detail' } }));
      const res = await request(server).post(`/api/fleet/repos/${registered.id}/check`).set(auth(admin)).expect(200);
      expect(data<{ reachable: boolean; reason: string }>(res)).toEqual(expect.objectContaining({ reachable: false, reason: 'app_not_installed' }));
      expect(JSON.stringify(res.body)).not.toContain('provider-internal-detail');
      const checkRequests = forge.requests.slice(requestStart);
      expect(checkRequests.some((r) => r.path === '/app/installations/77/access_tokens')).toBe(true);
      expect(checkRequests.some((r) => r.path === '/app/installations/99/access_tokens')).toBe(false);
      expect(checkRequests.some((r) => r.path === '/repos/acme/app/installation')).toBe(false);

      const prisma = fixtureDb(app);
      const afterCheck = await prisma.fleetRepo.findUniqueOrThrow({ where: { id: registered.id } });
      expect(afterCheck.githubInstallationId).toBe(BigInt(77));
    } finally {
      if (previousDiscovery) forge.routes.set(discoveryRoute, previousDiscovery);
      else forge.routes.delete(discoveryRoute);
      if (previousMint) forge.routes.set(persistedMintRoute, previousMint);
      else forge.routes.delete(persistedMintRoute);
    }
  });

  it('keeps the repo check to admins and 404s an unknown repo', async () => {
    await request(server).post('/api/fleet/repos/nope/check').set(auth(admin)).expect(404);
    await request(server).post('/api/fleet/repos/nope/check').set(auth(member)).expect(403);
  });

  it('deletes a repo and records the activity', async () => {
    const all = data<{ records: Array<{ id: string; name: string }> }>(await request(server).get('/api/fleet/repos').set(auth(admin)).expect(200));
    const target = all.records.find((r) => r.name === 'app');
    await request(server).delete(`/api/fleet/repos/${target?.id}`).set(auth(admin)).expect(204);
    const activity = data<{ records: Array<{ action: string }> }>(await request(server).get('/api/fleet/activity?entityType=repo').set(auth(admin)).expect(200));
    expect(activity.records.map((a) => a.action)).toEqual(expect.arrayContaining(['repo.created', 'repo.deleted']));
  });
});
