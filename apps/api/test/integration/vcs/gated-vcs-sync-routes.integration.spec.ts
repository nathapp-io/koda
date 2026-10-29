import { createTestPrismaClient, testDatabaseUrl } from '../../helpers/test-prisma';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import type { VcsIssue } from '../../../src/vcs/types';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
interface Pending { id: string; permissionKey: string; projectId: string }
interface Settled { status: string; result: { issuesSynced?: number; error?: string } }

describeIntegration('gated manual VCS sync', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  let sequence = 0;
  const server = () => app.getHttpServer();
  const auth = (token = agent.apiKey) => ({ Authorization: `Bearer ${token}` });
  const root = () => auth(world.tokens.root);
  const post = (suffix = '', token = agent.apiKey) => request(server()).post(`/api/projects/${p.slug}/vcs/sync${suffix}`).set(auth(token));
  const pending = (res: request.Response) => { expect(res.status).toBe(202); return data<Pending>(res); };
  const approve = async (id: string) => data<Settled>(await request(server()).post(`/api/approvals/${id}/decisions`).set(root()).send({ decision: 'approve' }).expect(200));
  const issue = (number: number): VcsIssue => ({ number, title: `Issue ${number}`, body: null, authorLogin: 'alice', url: `https://github.com/acme/${p.slug}/issues/${number}`, labels: [], createdAt: new Date() });
  const tickets = () => db.ticket.findMany({ where: { projectId: p.id, externalVcsId: { not: null } }, take: 10 });
  beforeAll(async () => {
    vi.stubEnv('VCS_ENCRYPTION_KEY', 'ab'.repeat(32));
    await resetDb();
    try {
      app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null });
    } finally {
      vi.unstubAllEnvs();
    }
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    sequence++;
    p = data(await request(server()).post('/api/projects').set(root()).send({ slug: `sync-${sequence}`, key: `SYNC${String.fromCharCode(64 + sequence)}`, name: 'Sync project' }).expect(201));
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'vcs.sync.issue', 'vcs.sync.all'], p.id);
    await app.get(PermissionCache).invalidate();
    await request(server()).post(`/api/projects/${p.slug}/vcs`).set(root()).send({ provider: 'github', repoOwner: 'acme', repoName: p.slug, token: 'fixture-token', syncMode: 'off' }).expect(201);
    await seedWaitPolicy(db, 'vcs.sync.issue', p.id);
    await seedWaitPolicy(db, 'vcs.sync.all', p.id);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('AC-1: pending single import has project scope and performs no fetch', async () => {
    const fetch = vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockResolvedValue(issue(7));
    expect(pending(await post('/7'))).toMatchObject({ permissionKey: 'vcs.sync.issue', projectId: p.id });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('AC-2: approval imports issue seven exactly once', async () => {
    const fetch = vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockResolvedValue(issue(7));
    const req = pending(await post('/7'));
    expect(fetch).not.toHaveBeenCalled();
    expect((await approve(req.id)).status).toBe('executed');
    expect(fetch).toHaveBeenCalledOnce();
    expect(await tickets()).toMatchObject([{ externalVcsId: `acme/${p.slug}#7` }]);
  });
  it('AC-3: target drift during fetch fails without writing', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockImplementation(async () => {
      await db.vcsConnection.update({ where: { projectId: p.id }, data: { repoName: 'changed' } });
      return issue(7);
    });
    const req = pending(await post('/7'));
    expect((await approve(req.id)).status).toBe('failed');
    expect(await tickets()).toEqual([]);
  });
  it('AC-4: a duplicate imported while waiting fails deferred single sync', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockResolvedValue(issue(7));
    const req = pending(await post('/7'));
    await post('/7', world.tokens.root).expect(200);
    expect((await approve(req.id)).status).toBe('failed');
    expect(await tickets()).toHaveLength(1);
  });
  it('AC-5: deferred full sync imports both issues and stores the count', async () => {
    const fetch = vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockResolvedValue({ issues: [issue(8), issue(9)], cursor: null, capped: false });
    const req = pending(await post());
    expect(fetch).not.toHaveBeenCalled();
    expect(await approve(req.id)).toMatchObject({ status: 'executed', result: { issuesSynced: 2 } });
    expect(fetch).toHaveBeenCalledOnce();
    expect((await tickets()).map((t) => t.externalVcsId).sort()).toEqual([`acme/${p.slug}#8`, `acme/${p.slug}#9`]);
  });
  function failSecondWrite() {
    const original = PrismaVcsRepository.prototype.createTicketFromIssue;
    vi.spyOn(PrismaVcsRepository.prototype, 'createTicketFromIssue').mockImplementation(function (...args) {
      if (args[1].number === 9) throw new Error('second write failed');
      return original.apply(this, args);
    });
  }
  it('AC-6: deferred full sync rolls back the first write when the second fails', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockResolvedValue({ issues: [issue(8), issue(9)], cursor: null, capped: false });
    failSecondWrite();
    const req = pending(await post());
    expect((await approve(req.id)).status).toBe('failed');
    expect(await tickets()).toEqual([]);
  });
  it('AC-7: no-policy agent full sync is best effort with no approval request', async () => {
    await db.approvalPolicy.deleteMany({ where: { projectId: p.id } });
    vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockResolvedValue({ issues: [issue(8), issue(9)], cursor: null, capped: false });
    failSecondWrite();
    expect(data(await post().expect(200))).toMatchObject({ issuesSynced: 1 });
    expect(await tickets()).toMatchObject([{ externalVcsId: `acme/${p.slug}#8` }]);
    expect(await db.approvalRequest.count({ where: { projectId: p.id } })).toBe(0);
  });
  it('AC-8: root bypasses wait policy and creates no request', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockResolvedValue(issue(7));
    await post('/7', world.tokens.root).expect(200);
    expect(await db.approvalRequest.count({ where: { projectId: p.id } })).toBe(0);
    expect(await tickets()).toHaveLength(1);
  });
  it('AC-13: allowedAuthors drift during fetch fails without writing', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockImplementation(async () => {
      await db.vcsConnection.update({ where: { projectId: p.id }, data: { allowedAuthors: '["bob"]' } });
      return { issues: [issue(8)], cursor: null, capped: false };
    });
    const req = pending(await post());
    expect((await approve(req.id)).status).toBe('failed');
    expect(await tickets()).toEqual([]);
  });
  it.each([
    ['/7', 'update'], ['/7', 'delete'], ['', 'update'], ['', 'delete'],
  ] as const)('F2: deferred sync%s holds the connection lock against concurrent %s through writes', async (suffix, mutation) => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssue').mockResolvedValue(issue(7));
    vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockResolvedValue({ issues: [issue(7)], cursor: null, capped: false });
    const req = pending(await post(suffix));
    // A separate session must not inherit the approval transaction's Prisma proxy.
    const url = new URL(testDatabaseUrl());
    url.searchParams.set('options', '-c lock_timeout=200ms');
    const concurrent = createTestPrismaClient(url.toString());
    const sql = mutation === 'update'
      ? `UPDATE "VcsConnection" SET "repoName" = 'changed', "allowedAuthors" = '["bob"]' WHERE "projectId" = $1`
      : 'DELETE FROM "VcsConnection" WHERE "projectId" = $1';
    let concurrentError: unknown;
    const original = PrismaVcsRepository.prototype.createTicketFromIssue;
    const write = vi.spyOn(PrismaVcsRepository.prototype, 'createTicketFromIssue').mockImplementation(async function (...args) {
      // The drift comparison has completed but the ticket write has not started yet.
      try {
        await concurrent.$executeRawUnsafe(sql, p.id);
      } catch (error) {
        concurrentError = error;
      }
      return original.apply(this, args);
    });
    await concurrent.$connect();
    try {
      expect((await approve(req.id)).status).toBe('executed');
      expect(write).toHaveBeenCalledOnce();
      expect(concurrentError).toBeInstanceOf(Error);
      expect(String(concurrentError)).toContain('lock timeout');
      expect(await tickets()).toMatchObject([{ externalVcsId: `acme/${p.slug}#7` }]);
      expect(await db.vcsConnection.findUniqueOrThrow({ where: { projectId: p.id } })).toMatchObject({ repoName: p.slug, allowedAuthors: '[]' });
      // Commit releases the lock: the same mutation can now finish normally.
      expect(await concurrent.$executeRawUnsafe(sql, p.id)).toBe(1);
    } finally {
      await concurrent.$disconnect();
    }
  });
  it('AC-14: provider fetch failure settles failed with execution-failed', async () => {
    vi.spyOn(GitHubProvider.prototype, 'fetchIssues').mockRejectedValue(new Error('fetch failed'));
    const req = pending(await post());
    expect(await approve(req.id)).toMatchObject({ status: 'failed', result: { error: 'execution-failed' } });
    expect(await tickets()).toEqual([]);
  });
});
