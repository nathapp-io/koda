import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { grantKeys, seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import { PermissionCache } from '../../../src/permissions/permission-cache';
import { GitHubProvider } from '../../../src/vcs/providers/github.provider';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { VcsLinkExtractorService } from '../../../src/vcs/vcs-link-extractor.service';
import type { VcsPrStatus } from '../../../src/vcs/types';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { seedFleetHttpAgent, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
describeIntegration('gated VCS PR sync', () => {
  let app: NathApplication;
  let db: ReturnType<typeof fixtureDb>;
  let world: FleetHttpWorld;
  let agent: Awaited<ReturnType<typeof seedFleetHttpAgent>>;
  let p: { id: string; slug: string };
  let link: { id: string };
  let sequence = 0;
  const server = () => app.getHttpServer();
  const auth = (token = agent.apiKey) => ({ Authorization: `Bearer ${token}` });
  const post = (token = agent.apiKey) => request(server()).post(`/api/projects/${p.slug}/vcs/sync-pr`).set(auth(token));
  const pending = async () => {
    const res = await post().expect(202);
    return data<{ id: string; permissionKey: string }>(res);
  };
  const approve = async (id: string) => data<{ status: string; result: unknown }>(await request(server()).post(`/api/approvals/${id}/decisions`).set(auth(world.tokens.root)).send({ decision: 'approve' }).expect(200));
  const status = (number = 12): VcsPrStatus => ({ number, state: 'closed', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: `https://github.com/acme/${p.slug}/pull/${number}`, title: 'PR', branchName: 'feat/x' });
  const readLink = () => db.ticketLink.findUniqueOrThrow({ where: { id: link.id } });
  async function makeLink(number: number) {
    const ticket = data<{ id: string }>(await request(server()).post(`/api/projects/${p.slug}/tickets`).set(auth(world.tokens.root)).send({ title: `PR ${number}`, type: 'BUG' }).expect(201));
    // The merge failure AC must reach the IN_PROGRESS-only transition.
    await db.ticket.update({ where: { id: ticket.id }, data: { status: 'IN_PROGRESS' } });
    return db.ticketLink.create({ data: { ticketId: ticket.id, provider: 'github', linkType: 'pr', url: status(number).url, externalRef: `acme/${p.slug}#${number}`, prNumber: number, prState: 'open' } });
  }
  beforeAll(async () => {
    vi.stubEnv('VCS_ENCRYPTION_KEY', 'ab'.repeat(32));
    await resetDb();
    try { app = await bootHttpApp({ registrationEnabled: true, ownerEmail: null }); }
    finally { vi.unstubAllEnvs(); }
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), db);
    agent = await seedFleetHttpAgent(server(), world.tokens.root);
  }, 60000);
  beforeEach(async () => {
    resetThrottle(app);
    sequence++;
    p = data(await request(server()).post('/api/projects').set(auth(world.tokens.root)).send({ slug: `pr-sync-${sequence}`, key: `PRS${String.fromCharCode(64 + sequence)}`, name: 'PR sync' }).expect(201));
    await grantKeys(db, { type: 'AGENT', id: agent.id }, ['project.read', 'vcs.sync.pr'], p.id);
    await app.get(PermissionCache).invalidate();
    await request(server()).post(`/api/projects/${p.slug}/vcs`).set(auth(world.tokens.root)).send({ provider: 'github', repoOwner: 'acme', repoName: p.slug, token: 'fixture-token', syncMode: 'off' }).expect(201);
    await seedWaitPolicy(db, 'vcs.sync.pr', p.id);
    link = await makeLink(12);
    vi.spyOn(GitHubProvider.prototype, 'getPullRequestStatus').mockResolvedValue(status());
    vi.spyOn(VcsLinkExtractorService.prototype, 'extractLinksFromPr').mockResolvedValue(undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  afterAll(async () => { await app?.close(); vi.unstubAllEnvs(); });

  it('AC-1: asks for vcs.sync.pr without fetching', async () => {
    expect(await pending()).toMatchObject({ permissionKey: 'vcs.sync.pr' });
    expect(GitHubProvider.prototype.getPullRequestStatus).not.toHaveBeenCalled();
  });
  it('AC-2: approval closes PR 12', async () => {
    expect((await approve((await pending()).id)).status).toBe('executed');
    expect((await readLink()).prState).toBe('closed');
  });
  it('AC-3: persists only updated', async () => {
    expect((await approve((await pending()).id)).result).toEqual({ updated: 1 });
  });
  it('AC-4: extracts once only after request is executed', async () => {
    const req = await pending();
    const observed: string[] = [];
    vi.mocked(VcsLinkExtractorService.prototype.extractLinksFromPr).mockImplementation(async () => {
      observed.push((await db.approvalRequest.findUniqueOrThrow({ where: { id: req.id } })).status);
    });
    await approve(req.id);
    await vi.waitFor(() => expect(observed).toEqual(['executed']));
    expect(VcsLinkExtractorService.prototype.extractLinksFromPr).toHaveBeenCalledOnce();
  });
  it('AC-5: fetch error rolls back both links', async () => {
    const second = await makeLink(13);
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockImplementation(async (number) => {
      if (number === 13) throw new Error('fetch failed');
      return status(number);
    });
    expect((await approve((await pending()).id)).status).toBe('failed');
    expect((await readLink()).prState).toBe('open');
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: second.id } })).prState).toBe('open');
    expect(VcsLinkExtractorService.prototype.extractLinksFromPr).not.toHaveBeenCalled();
  });
  it('AC-11: root response exposes only updated', async () => {
    expect(data(await post(world.tokens.root).expect(200))).toEqual({ updated: 1 });
  });
  it('AC-12: merge transition failure rolls back link', async () => {
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockResolvedValue({ ...status(), merged: true });
    const transition = vi.spyOn(PrismaVcsRepository.prototype, 'applyMergedPrTransition').mockRejectedValue(new Error('transition failed'));
    expect((await approve((await pending()).id)).status).toBe('failed');
    expect(transition).toHaveBeenCalledOnce();
    expect((await readLink()).prState).toBe('open');
  });
  it('AC-13: connection drift after fetch fails before write', async () => {
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockImplementation(async () => {
      await db.vcsConnection.update({ where: { projectId: p.id }, data: { repoName: 'changed' } });
      return status();
    });
    expect((await approve((await pending()).id)).status).toBe('failed');
    expect((await readLink()).prState).toBe('open');
  });
  it.each(['open', 'draft', 'merged'] as const)('F1: preserves a concurrent close before applying fetched %s', async (next) => {
    // Ensure the fetched state differs from the preparation snapshot in every case.
    await db.ticketLink.update({ where: { id: link.id }, data: { prState: next === 'open' ? 'draft' : 'open' } });
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockImplementation(async () => {
      await db.ticketLink.update({ where: { id: link.id }, data: { prState: 'closed' } });
      return { ...status(), state: 'open', draft: next === 'draft', merged: next === 'merged' };
    });
    expect(await approve((await pending()).id)).toMatchObject({ status: 'executed', result: { updated: 0 } });
    expect((await readLink()).prState).toBe('closed');
    expect(VcsLinkExtractorService.prototype.extractLinksFromPr).not.toHaveBeenCalled();
  });
  it('F2: preserves a ticket status changed after preparation without false transition records', async () => {
    const ticketId = (await readLink()).ticketId;
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockImplementation(async () => {
      await db.ticket.update({ where: { id: ticketId }, data: { status: 'CLOSED' } });
      return { ...status(), merged: true };
    });
    expect(await approve((await pending()).id)).toMatchObject({ status: 'executed', result: { updated: 1 } });
    expect((await readLink()).prState).toBe('merged');
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status).toBe('CLOSED');
    expect(await db.comment.count({ where: { ticketId, type: 'FIX_REPORT' } })).toBe(0);
    expect(await db.ticketActivity.count({ where: { ticketId, action: 'VCS_PR_MERGED' } })).toBe(0);
    expect(await db.auditEntry.count({ where: { resourceId: ticketId, key: 'system.vcs.pr-merge-transition' } })).toBe(0);
  });
  it('AC-14: missing PR close write failure propagates', async () => {
    vi.mocked(GitHubProvider.prototype.getPullRequestStatus).mockRejectedValue(new NotFoundAppException({}, 'vcs'));
    const write = vi.spyOn(PrismaVcsRepository.prototype, 'updateTicketLinkWithPrState').mockRejectedValue(new Error('close failed'));
    expect((await approve((await pending()).id)).status).toBe('failed');
    expect(write).toHaveBeenCalledOnce();
    expect((await readLink()).prState).toBe('open');
  });
});
