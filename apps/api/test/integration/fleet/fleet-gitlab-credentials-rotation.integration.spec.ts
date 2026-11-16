import request from 'supertest';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { NathApplication } from '@nathapp/nestjs-app';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, loginToken, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { asTestActor, fixtureDb } from '../../helpers/action-context';
import { grantKeys } from '../../../src/approvals/test-helpers/approval-fixtures';
import { REDACTED_SECRET } from '../../../src/approvals/route/redact-secret';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitLabAccessChecker } from '../../../src/fleet/git-broker/gitlab-access-checker';
import { GitLabRepoCredentials } from '../../../src/fleet/git-broker/gitlab-repo-credentials';
import type { PrismaClient } from '../../../src/generated/prisma/client';

/**
 * US-005: the rotation of a repo's GitLab tokens, end to end (PG).
 *
 * The GitLab client is stubbed (gitlab.com is not served locally), but the host rule stays strict:
 * the resolver is stubbed with an address inside an allowed subnet, so a rotation still has to pass
 * the same host check a real one does.
 *
 * Every case builds its own repo and credential row, so a case never depends on the order the file
 * runs in and a rotation in one case cannot be read by another.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-gitlab-credentials-rotation.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;
const ENC_KEY = 'd'.repeat(64);

interface Pending { id: string; permissionKey: string; projectId: string | null }

describeIntegration('the fleet repo GitLab credential rotation (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let credentials: GitLabRepoCredentials;
  let admin: string;
  let member: string;
  let projectId: string;
  let rootId: string;
  let dnsLookup: ReturnType<typeof vi.spyOn>;
  /** The stubbed verification call the F1 case asserts was never made. */
  let tokenSelf: ReturnType<typeof vi.spyOn>;
  let seq = 0;
  const saved: Record<string, string | undefined> = {};
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const pending = (res: request.Response, permissionKey: string) => {
    expect(res.status).toBe(202);
    const summary = data<Pending>(res);
    expect(summary).toMatchObject({ permissionKey, projectId: null });
    return summary;
  };

  /** A registered GitLab repo with a stored connection: the stored project id is 42. */
  const gitlabRepo = async (): Promise<string> => {
    const row = await db.fleetRepo.create({
      data: {
        projectId, provider: 'gitlab', owner: 'infra', name: `deploy-${++seq}`, defaultBranch: 'main',
        host: 'https://gitlab.com', createdById: rootId,
      },
    });
    await credentials.save(row.id, {
      gitlabProjectId: 42,
      read: { token: 'glpat-read', userId: 11, username: 'koda-reader', expiresAt: null },
      write: { token: 'glpat-write', userId: 12, username: 'koda-bot', expiresAt: null, isBot: true },
    });
    return row.id;
  };

  /** The tokens a repo's connection answers with now. */
  const storedTokens = async (repoId: string) => {
    const repo = { id: repoId, host: 'https://gitlab.com' };
    const write = await credentials.resolve(repo, 'write');
    const read = await credentials.resolve(repo, 'read');
    return { write: write.token, read: read.token };
  };

  const rotate = (repoId: string, body: unknown, token = admin) =>
    request(server).patch(`/api/fleet/repos/${repoId}/gitlab-credentials`).set(auth(token)).send(body);

  beforeAll(async () => {
    saved['VCS_ENCRYPTION_KEY'] = process.env['VCS_ENCRYPTION_KEY'];
    process.env['VCS_ENCRYPTION_KEY'] = ENC_KEY;
    dnsLookup = vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '192.168.1.20', family: isIP('192.168.1.20') }] as never);
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    db = fixtureDb(app);
    // The store and the audit recorder need an action context, which a suite has no request for.
    credentials = asTestActor(app.get(GitLabRepoCredentials, { strict: false }), { type: 'SYSTEM', id: 'seed' });

    admin = data<{ accessToken: string }>(
      await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
    ).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth(admin)).send({ name: 'Ops', slug: 'ops', key: 'OPS' }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: 'ops' } })).id;
    await request(server).post('/api/admin/users').set(auth(admin)).send({ email: 'm@koda.test', name: 'm', password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    member = await loginToken(server, 'm@koda.test');

    // The verification calls the rotation makes; the forge itself is not served locally.
    const checker = app.get(GitLabAccessChecker);
    tokenSelf = vi.spyOn(checker, 'getTokenSelf').mockImplementation(async (_apiBase: string, token: string) => ({
      scopes: token.startsWith('glpat-write') ? ['api', 'write_repository'] : ['read_api', 'read_repository'],
      expiresAt: null,
    }));
    vi.spyOn(checker, 'getCurrentUser').mockImplementation(async (_apiBase: string, token: string) => (
      token.startsWith('glpat-write')
        ? { id: 12, username: 'koda-bot-2', bot: true }
        : { id: 11, username: 'koda-reader-2', bot: true }
    ));
    vi.spyOn(checker, 'findProject').mockResolvedValue({
      id: 42, owner: 'infra', name: 'deploy', defaultBranch: 'main', accessLevel: 30,
    });
  }, 60_000);

  afterAll(async () => {
    dnsLookup.mockRestore();
    await app?.close();
    if (saved['VCS_ENCRYPTION_KEY'] === undefined) delete process.env['VCS_ENCRYPTION_KEY'];
    else process.env['VCS_ENCRYPTION_KEY'] = saved['VCS_ENCRYPTION_KEY'];
  });

  beforeEach(async () => {
    resetThrottle(app);
    tokenSelf.mockClear();
    await db.approvalRequest.deleteMany();
    await db.auditEntry.deleteMany({ where: { key: 'fleet.repo.credentials.update' } });
  });

  it('AC-1: a body without a token is a 400 with the fleet.repoGitlabCredentialsEmpty message', async () => {
    const repoId = await gitlabRepo();

    const res = await rotate(repoId, {}).expect(400);

    expect(res.body.message).toBe('A GitLab credential rotation must carry at least one token');
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-1 (fix round 1, F1): a null token is a 400 and reaches no GitLab call', async () => {
    const repoId = await gitlabRepo();

    const res = await rotate(repoId, { writeToken: null }).expect(400);

    // `null` is a malformed token, not an absent one: the body is refused before anything else runs.
    // Which constraint reports it is class-validator's business (`stopAtFirstError`); what matters is
    // that the refusal is a translated 400 and nothing else happened.
    expect(res.body.message).toEqual(expect.any(String));
    expect(res.body.message).not.toContain('common.validation');
    expect(tokenSelf).not.toHaveBeenCalled();
    expect(await db.approvalRequest.count()).toBe(0);
    expect(await storedTokens(repoId)).toEqual({ write: 'glpat-write', read: 'glpat-read' });
  });

  it('AC-2: a GitHub repo cannot rotate GitLab credentials', async () => {
    const githubRepo = await db.fleetRepo.create({
      data: {
        projectId, provider: 'github', owner: 'acme', name: `app-${++seq}`, defaultBranch: 'trunk',
        githubInstallationId: BigInt(77), createdById: rootId,
      },
    });

    const res = await rotate(githubRepo.id, { writeToken: 'glpat-write-2' }).expect(400);

    expect(res.body.message).toBe('This repository is not a GitLab repository');
    expect(await db.auditEntry.count({ where: { key: 'fleet.repo.credentials.update' } })).toBe(0);
  });

  it('AC-3: a new write token replaces the stored write token, keeps the read token and is audited', async () => {
    const repoId = await gitlabRepo();

    const res = await rotate(repoId, { writeToken: 'glpat-write-2' }).expect(200);

    // The answer carries the new credential summary and no token.
    const answer = data<{ gitlab: { projectId: number; writeToken: { username: string; isBot: boolean } } }>(res);
    expect(answer.gitlab).toMatchObject({ projectId: 42, writeToken: { username: 'koda-bot-2', isBot: true } });
    expect(JSON.stringify(res.body)).not.toContain('glpat-write-2');

    // The stored credential carries the new write token and the untouched read token.
    expect(await storedTokens(repoId)).toEqual({ write: 'glpat-write-2', read: 'glpat-read' });

    // The audit names the write of the rotation.
    const entries = await db.auditEntry.findMany({ where: { key: 'fleet.repo.credentials.update', resourceId: repoId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe('write token replaced');
  });

  it('AC-12: a caller without the key is refused and the stored tokens stay', async () => {
    const repoId = await gitlabRepo();
    const before = await storedTokens(repoId);

    await rotate(repoId, { writeToken: 'glpat-write-3' }, member).expect(403);

    expect(await storedTokens(repoId)).toEqual(before);
    expect(await db.approvalRequest.count()).toBe(0);
  });

  it('AC-13: an agent waits for an approval and the stored request holds no token', async () => {
    const repoId = await gitlabRepo();
    const before = await storedTokens(repoId);
    const agent = data<{ agent: { id: string }; apiKey: string }>(
      await request(server).post('/api/agents').set(auth(admin)).send({ name: 'rotator', slug: 'rotator', capabilities: ['typescript'] }).expect(201),
    );
    await grantKeys(db, { type: 'AGENT', id: agent.agent.id }, ['fleet.repo.credentials.update'], null);
    await app.get(PermissionCache).invalidate();

    const summary = pending(
      await rotate(repoId, { writeToken: 'glpat-write-4' }, agent.apiKey),
      'fleet.repo.credentials.update',
    );

    const stored = await db.approvalRequest.findUniqueOrThrow({ where: { id: summary.id } });
    expect(stored.input).toEqual({ id: repoId, patch: { writeToken: REDACTED_SECRET } });
    expect(JSON.stringify(stored.input)).not.toContain('glpat-write-4');

    // The stored credential is untouched while the request waits.
    expect(await storedTokens(repoId)).toEqual(before);
  });
});
