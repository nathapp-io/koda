import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

vi.mock('../../../src/vcs/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/vcs/factory')>();
  return { ...actual, createVcsProvider: vi.fn() };
});
import { createVcsProvider } from '../../../src/vcs/factory';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const SLUG = 'vcs-pr-state-audit';
const BASE = `/api/projects/${SLUG}/vcs`;
const WEBHOOK = `/api/projects/${SLUG}/vcs-webhook`;
const describeKey = 'vcs.sync.pr';
const provider = { getPullRequestStatus: vi.fn(), fetchIssues: vi.fn(), fetchIssue: vi.fn(), testConnection: vi.fn(), listPrCommits: vi.fn() };

describeIntegration('VCS PR-state audit entries', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let token: string;
  let rootId: string;
  let projectId: string;
  let webhookSecret: string;
  let delivery = 0;
  let restoreRecord: (() => void) | undefined;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const newLink = async (state: string | null = 'open', prNumber = ++delivery) => {
    const ticket = await db.ticket.create({ data: {
      projectId, number: 1000 + prNumber, type: 'TASK', title: `PR ticket ${prNumber}`,
      description: null, status: 'CREATED', priority: 'MEDIUM',
    } });
    const link = await db.ticketLink.create({ data: {
      ticketId: ticket.id, url: `https://github.com/acme/app/pull/${prNumber}`,
      provider: 'github', prNumber, prState: state, linkType: 'pr',
    } });
    return { ticket, link };
  };
  const rows = (linkId: string) => db.auditEntry.findMany({ where: { resourceId: linkId } });
  const prStatus = (number: number, state: string, merged = false) => ({
    number, state, draft: state === 'draft', merged, mergedAt: null, mergedBy: null, mergeSha: null,
    url: `https://github.com/acme/app/pull/${number}`, title: 'Sensitive PR title',
  });
  const deliver = (number: number, action: string, merged = false, deliveryId?: string) => {
    const payload = { action, pull_request: {
      number, title: 'Sensitive PR title', body: null, user: { login: 'octo' },
      html_url: `https://github.com/acme/app/pull/${number}`, state: 'closed', draft: false,
      merged, merged_at: null, merged_by: null, base: { ref: 'main', repo: { full_name: 'acme/app' } },
      head: { ref: 'feature', repo: { full_name: 'acme/app' } },
    } };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
    return request(server).post(WEBHOOK).set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature).set('x-github-event', 'pull_request')
      .set('x-github-delivery', deliveryId ?? `vcs-pr-audit-${++delivery}`).send(body);
  };
  const rejectRecord = (key: string) => {
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === key) throw new Error('audit down');
      await original(input);
    });
    restoreRecord = () => spy.mockRestore();
  };

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: true });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'vcs-pr-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'vcs-pr-audit-root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth()).send({ name: 'VCS PR audit', slug: SLUG, key: 'VPA' }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: SLUG } })).id;
    const created = await request(server).post(BASE).set(auth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_audit_token', syncMode: 'webhook',
    }).expect(201);
    webhookSecret = data<{ webhookSecret: string }>(created).webhookSecret;
  });
  beforeEach(async () => {
    resetThrottle(app);
    await db.ticketLink.deleteMany({ where: { ticket: { projectId } } });
    provider.getPullRequestStatus.mockReset();
    provider.getPullRequestStatus.mockResolvedValue(prStatus(1, 'closed'));
    vi.mocked(createVcsProvider).mockReturnValue(provider as never);
  });
  afterEach(() => { restoreRecord?.(); restoreRecord = undefined; });
  afterAll(async () => {
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
  });

  it('AC-1/AC-2: manual PR sync records the state change only, for the request actor', async () => {
    const { link } = await newLink('open');
    provider.getPullRequestStatus.mockResolvedValue(prStatus(link.prNumber!, 'closed'));
    await request(server).post(`${BASE}/sync-pr`).set(auth()).expect(201);
    expect(await rows(link.id)).toHaveLength(1);
    expect(await rows(link.id)).toMatchObject([{
      key: describeKey, resourceType: 'ticket-link', resourceId: link.id, projectId,
      actorType: 'USER', actorId: rootId, origin: 'rest', summary: 'pr open -> closed',
    }]);

    const unchanged = await newLink('open');
    provider.getPullRequestStatus.mockResolvedValue(prStatus(unchanged.link.prNumber!, 'open'));
    await request(server).post(`${BASE}/sync-pr`).set(auth()).expect(201);
    expect(await rows(unchanged.link.id)).toHaveLength(0);
  });

  it('AC-3/AC-20/AC-21: provider 404 close is audited and rolls back/counts skipped if audit fails', async () => {
    const { link } = await newLink('draft');
    provider.getPullRequestStatus.mockRejectedValue(new NotFoundAppException({}, 'vcs'));
    rejectRecord(describeKey);
    const response = await request(server).post(`${BASE}/sync-pr`).set(auth()).expect(201);
    expect(data<{ updated: number }>(response).updated).toBe(0);
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: link.id } })).prState).toBe('draft');
    expect(await rows(link.id)).toHaveLength(0);
  });

  it('AC-4: poller key is recorded with SYSTEM/vcs actor', async () => {
    const { link } = await newLink('draft');
    provider.getPullRequestStatus.mockResolvedValue(prStatus(link.prNumber!, 'open'));
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });
    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () =>
      app.get(VcsPrSyncService).syncPrStatus(project, connection, 'ab'.repeat(32), 'system.vcs.poll-issues'));
    expect(await rows(link.id)).toMatchObject([{
      key: 'system.vcs.poll-issues', actorType: 'SYSTEM', actorId: 'vcs', summary: 'pr draft -> open',
    }]);
  });

  it('AC-5/AC-6/AC-14/AC-15/AC-16/AC-17: webhook null-state close records, rolls back, and retries', async () => {
    const { link } = await newLink(null);
    const eventId = `vcs-pr-audit-retry-${link.id}`;
    rejectRecord('system.vcs.webhook-intake');
    await deliver(link.prNumber!, 'closed', false, eventId).expect(500);
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: link.id } })).prState).toBeNull();
    restoreRecord?.(); restoreRecord = undefined;
    await deliver(link.prNumber!, 'closed', false, eventId).expect(200);
    expect(await rows(link.id)).toMatchObject([{
      key: 'system.vcs.webhook-intake', resourceType: 'ticket-link', projectId,
      actorType: 'SYSTEM', actorId: 'vcs', summary: 'pr none -> closed',
    }]);
  });

  it('AC-7/AC-8/AC-9: converted-to-draft is recorded; same-state reopen is not', async () => {
    const { link } = await newLink('open');
    await deliver(link.prNumber!, 'converted_to_draft').expect(200);
    expect(await rows(link.id)).toMatchObject([{
      key: 'system.vcs.webhook-intake', summary: 'pr open -> draft',
    }]);
    const reopened = await newLink('open');
    await deliver(reopened.link.prNumber!, 'reopened').expect(200);
    expect(await rows(reopened.link.id)).toHaveLength(0);
  });

  it('AC-22/AC-23/AC-24/AC-28/AC-29: failed, terminal and vanished PR writes are skipped and later links continue', async () => {
    const first = await newLink('draft');
    const second = await newLink('draft');
    provider.getPullRequestStatus
      .mockResolvedValueOnce(prStatus(first.link.prNumber!, 'open'))
      .mockResolvedValueOnce(prStatus(second.link.prNumber!, 'open'));
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.resourceId === first.link.id) throw new Error('audit down');
      await original(input);
    });
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });
    const result = await app.get(VcsPrSyncService).syncPrStatus(project, connection, 'ab'.repeat(32), describeKey);
    spy.mockRestore();
    expect(result.skipped).toBe(1);
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: first.link.id } })).prState).toBe('draft');
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: second.link.id } })).prState).toBe('open');
    expect(await rows(first.link.id)).toHaveLength(0);
    expect(await rows(second.link.id)).toHaveLength(1);

    const terminal = await newLink('closed');
    const vanished = await newLink('draft');
    provider.getPullRequestStatus.mockResolvedValueOnce(prStatus(terminal.link.prNumber!, 'open'))
      .mockResolvedValueOnce(prStatus(vanished.link.prNumber!, 'open'));
    const repo = app.get(VcsPrSyncService);
    // A deleted row is reported by the repository's conditional write as not-found.
    await db.ticketLink.delete({ where: { id: vanished.link.id } });
    const terminalResult = await repo.syncPrStatus(project, connection, 'ab'.repeat(32), describeKey);
    expect(terminalResult.updated).toBe(0);
    expect(await rows(terminal.link.id)).toHaveLength(0);
  });

  it('AC-25/AC-26/AC-27: rejected audit on a provider-404 close counts one skipped and continues', async () => {
    const first = await newLink('draft');
    const second = await newLink('draft');
    provider.getPullRequestStatus.mockRejectedValueOnce(new NotFoundAppException({}, 'vcs'))
      .mockResolvedValueOnce(prStatus(second.link.prNumber!, 'open'));
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.resourceId === first.link.id) throw new Error('audit down');
      await original(input);
    });
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });
    const result = await app.get(VcsPrSyncService).syncPrStatus(project, connection, 'ab'.repeat(32), describeKey);
    spy.mockRestore();
    expect(result.skipped).toBe(1);
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: first.link.id } })).prState).toBe('draft');
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: second.link.id } })).prState).toBe('open');
  });

  it('AC-10/AC-11/AC-12/AC-13: merged and missing links are ignored without audit', async () => {
    const { link } = await newLink('merged');
    await deliver(link.prNumber!, 'closed').expect(200);
    expect((await db.ticketLink.findUniqueOrThrow({ where: { id: link.id } })).prState).toBe('merged');
    expect(await rows(link.id)).toHaveLength(0);
    const before = await db.auditEntry.count({ where: { key: 'system.vcs.webhook-intake' } });
    const ignored = await deliver(99999, 'closed').expect(200);
    expect(ignored.body).toMatchObject({ ignored: true });
    expect(await db.auditEntry.count({ where: { key: 'system.vcs.webhook-intake' } })).toBe(before);
  });
});
