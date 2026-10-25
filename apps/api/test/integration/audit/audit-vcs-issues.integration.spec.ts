/**
 * Permissions P2 US-002 — VCS issue imports are audited (spec AC1–AC9, AC13, failure table).
 *
 * The ACs enter through the booted `AppModule`: the two manual sync routes and the signed issues
 * webhook over HTTP, and the poller's own entry point by calling `VcsSyncService.syncIssue` with the
 * poller's key inside `withTestActor({ type: 'SYSTEM', id: 'vcs' })` — the context `tick` establishes.
 * Each asserts the stored `AuditEntry` row, so it proves the writer reaches the recorder rather than a
 * stub.
 */
import { createHmac } from 'node:crypto';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { VcsSyncService } from '../../../src/vcs/vcs-sync.service';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

// The provider is stubbed; the rest of the factory (`parseRepoPath`) is used by the connection routes.
vi.mock('../../../src/vcs/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/vcs/factory')>();
  return { ...actual, createVcsProvider: vi.fn() };
});

import { createVcsProvider } from '../../../src/vcs/factory';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const SLUG = 'vcs-issue-audit';
const KEY = 'VIA';
const BASE = `/api/projects/${SLUG}/vcs`;
const WEBHOOK = `/api/projects/${SLUG}/vcs-webhook`;
const POLL_KEY = 'system.vcs.poll-issues';

interface AuditRow {
  key: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  actorType: string;
  actorId: string;
  origin: string;
  summary: string | null;
  onBehalfOfType: string | null;
  onBehalfOfId: string | null;
}

const issue = (number: number, title = `Issue ${number}`, body: string | null = null) => ({
  number,
  title,
  body,
  authorLogin: 'octo',
  url: `https://github.com/acme/app/issues/${number}`,
  labels: [],
  createdAt: new Date('2026-10-01T00:00:00Z'),
});

describeIntegration('VCS issue import audit (real AppModule)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let server: Parameters<typeof request>[0];
  let token: string;
  let projectId: string;
  let rootId: string;
  let webhookSecret: string;
  let deliveries = 0;
  const provider = {
    fetchIssue: vi.fn(),
    fetchIssues: vi.fn(),
    testConnection: vi.fn(),
    getPullRequestStatus: vi.fn(),
    listPrCommits: vi.fn(),
  };
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const ticketWithIssue = (number: number) =>
    db.ticket.findFirstOrThrow({ where: { projectId, externalVcsId: `acme/app#${number}` } });
  const importRowsOf = async (resourceId: string, key: string): Promise<AuditRow[]> =>
    (await db.auditEntry.findMany({ where: { resourceId, key } })) as AuditRow[];
  const rowsOf = async (resourceId: string): Promise<AuditRow[]> =>
    (await db.auditEntry.findMany({ where: { resourceId } })) as AuditRow[];
  let restoreRecord: (() => void) | undefined;

  /** A signed delivery of the connection's webhook; `deliveryId` defaults to a fresh one. */
  const deliver = (payload: unknown, event = 'issues', deliveryId?: string) => {
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
    return request(server)
      .post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .set('x-github-event', event)
      .set('x-github-delivery', deliveryId ?? `vcs-issue-audit-${++deliveries}`)
      .send(body);
  };

  /** Makes `record` reject only for `key`, so one AC's spy cannot leak into the next. */
  const rejectRecordingOf = (key: string): void => {
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
      email: 'vcs-issue-audit-root@koda.test', name: 'Root', password: TEST_PASSWORD,
    }).expect(201);
    token = data<{ accessToken: string }>(registered).accessToken;
    rootId = (await db.user.findUniqueOrThrow({ where: { email: 'vcs-issue-audit-root@koda.test' } })).id;
    await request(server).post('/api/projects').set(auth())
      .send({ name: 'VCS Issue Audit', slug: SLUG, key: KEY }).expect(201);
    projectId = (await db.project.findUniqueOrThrow({ where: { slug: SLUG } })).id;
    const created = await request(server).post(BASE).set(auth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_audit_token', syncMode: 'webhook',
    }).expect(201);
    webhookSecret = data<{ webhookSecret: string }>(created).webhookSecret;
  });

  beforeEach(() => {
    resetThrottle(app);
    vi.mocked(createVcsProvider).mockReturnValue(provider as never);
    provider.fetchIssue.mockReset();
    provider.fetchIssues.mockReset();
  });

  afterEach(() => {
    restoreRecord?.();
    restoreRecord = undefined;
  });

  afterAll(async () => {
    await app?.close();
    if (previousKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousKey;
  });

  it('AC-1/AC-2/AC-3: the one-issue route imports issue 7 and audits it without its title or body', async () => {
    provider.fetchIssue.mockResolvedValue(issue(7, 'Private title', 'Private body'));

    // The route answers Nest's POST default 201 (it declares no @HttpCode); openapi.json documents 200,
    // and a route's status codes are outside this story, so the AC's "200" is read as "a success".
    const response = await request(server).post(`${BASE}/sync/7`).set(auth()).expect(201);
    const body = data<{ issuesSynced: number; issuesSkipped: number; tickets: Array<{ ref: string; title: string }> }>(response);
    expect(body.issuesSynced).toBe(1);
    expect(body.issuesSkipped).toBe(0);
    expect(body.tickets).toHaveLength(1);
    expect(provider.fetchIssue).toHaveBeenCalledWith(7);

    const ticket = await ticketWithIssue(7);
    const rows = await rowsOf(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'vcs.sync.issue',
      resourceType: 'ticket',
      resourceId: ticket.id,
      projectId,
      actorType: 'USER',
      actorId: rootId,
      origin: 'rest',
      summary: 'imported issue #7',
      onBehalfOfType: null,
      onBehalfOfId: null,
    });
    expect(await importRowsOf(ticket.id, 'vcs.sync.issue')).toHaveLength(1);
    expect(rows[0].summary).not.toContain('Private title');
    expect(rows[0].summary).not.toContain('Private body');
  });

  it('AC-4/AC-5: repeating the one-issue import is a 409 and records nothing', async () => {
    provider.fetchIssue.mockResolvedValue(issue(7, 'Private title', 'Private body'));
    // AC-1's import, repeated here so this test also passes alone: whichever request created issue 7,
    // the next one is the duplicate the AC names.
    await request(server).post(`${BASE}/sync/7`).set(auth());
    const ticket = await ticketWithIssue(7);
    const before = await importRowsOf(ticket.id, 'vcs.sync.issue');

    await request(server).post(`${BASE}/sync/7`).set(auth()).expect(409);

    expect(before).toHaveLength(1);
    expect(await importRowsOf(ticket.id, 'vcs.sync.issue')).toHaveLength(1);
    expect(await db.ticket.count({ where: { projectId, externalVcsId: 'acme/app#7' } })).toBe(1);
  });

  it('AC-6: the full-sync route audits each import with vcs.sync.all and its own issue number', async () => {
    provider.fetchIssues.mockResolvedValue({ issues: [issue(8), issue(9)], cursor: null, capped: false });

    const response = await request(server).post(`${BASE}/sync`).set(auth()).expect(201);
    const body = data<{ issuesSynced: number; tickets: unknown[] }>(response);
    expect(body.issuesSynced).toBe(2);

    for (const [number, summary] of [[8, 'imported issue #8'], [9, 'imported issue #9']] as const) {
      const ticket = await ticketWithIssue(number);
      const rows = await rowsOf(ticket.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        key: 'vcs.sync.all', resourceType: 'ticket', projectId,
        actorType: 'USER', actorId: rootId, origin: 'rest', summary,
      });
    }
  });

  it('AC-7/AC-8: the signed issues webhook imports issue 10 as SYSTEM/vcs', async () => {
    const response = await deliver({
      action: 'opened',
      issue: {
        number: 10,
        title: 'Webhook issue',
        body: 'Webhook body',
        user: { login: 'octo' },
        html_url: 'https://github.com/acme/app/issues/10',
        labels: [],
        created_at: '2026-10-02T10:00:00Z',
      },
    }).expect(200);
    expect(response.body).toMatchObject({ success: true, ignored: false });

    const ticket = await ticketWithIssue(10);
    const rows = await rowsOf(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'system.vcs.webhook-intake',
      resourceType: 'ticket',
      resourceId: ticket.id,
      projectId,
      actorType: 'SYSTEM',
      actorId: 'vcs',
      origin: 'system',
      summary: 'imported issue #10',
    });
  });

  it('AC-9/AC-10: the poller key imports issue 11 as SYSTEM/vcs', async () => {
    const sync = app.get(VcsSyncService);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });

    const result = await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () =>
      sync.syncIssue(project, issue(11), 'polling', connection, POLL_KEY));

    expect(result.action).toBe('created');
    const ticket = await ticketWithIssue(11);
    const rows = await rowsOf(ticket.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: POLL_KEY, resourceType: 'ticket', resourceId: ticket.id, projectId,
      actorType: 'SYSTEM', actorId: 'vcs', origin: 'system', summary: 'imported issue #11',
    });
  });

  it('AC-11/AC-12: a rejected record fails the one-issue route and leaves no ticket', async () => {
    provider.fetchIssue.mockResolvedValue(issue(12));
    rejectRecordingOf('vcs.sync.issue');

    const response = await request(server).post(`${BASE}/sync/12`).set(auth());

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await db.ticket.count({ where: { projectId, externalVcsId: 'acme/app#12' } })).toBe(0);
  });

  it('AC-13/AC-14: a rejected record counts the full-sync issue skipped and leaves no ticket', async () => {
    provider.fetchIssues.mockResolvedValue({ issues: [issue(13)], cursor: null, capped: false });
    rejectRecordingOf('vcs.sync.all');

    const response = await request(server).post(`${BASE}/sync`).set(auth()).expect(201);
    const body = data<{ issuesSynced: number; issuesSkipped: number; tickets: unknown[] }>(response);

    expect(body.issuesSynced).toBe(0);
    expect(body.issuesSkipped).toBe(1);
    expect(body.tickets).toEqual([]);
    expect(await db.ticket.count({ where: { projectId, externalVcsId: 'acme/app#13' } })).toBe(0);
  });

  it('AC-15/AC-16/AC-17: ten concurrent poll imports all record once with distinct numbers', async () => {
    const sync = app.get(VcsSyncService);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });
    const issues = Array.from({ length: 10 }, (_, index) => issue(20 + index));

    const results = await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () =>
      Promise.all(issues.map((one) => sync.syncIssue(project, one, 'polling', connection, POLL_KEY))));

    expect(results.map((result) => result.action)).toEqual(Array.from({ length: 10 }, () => 'created'));
    const created = await db.ticket.findMany({
      where: { projectId, externalVcsId: { in: issues.map((one) => `acme/app#${one.number}`) } },
      orderBy: { number: 'asc' },
    });
    expect(created).toHaveLength(10);
    expect(new Set(created.map((ticket) => ticket.number)).size).toBe(10);

    for (const ticket of created) {
      expect(await importRowsOf(ticket.id, POLL_KEY)).toHaveLength(1);
    }
    expect(await db.auditEntry.count({
      where: { key: POLL_KEY, resourceId: { in: created.map((ticket) => ticket.id) } },
    })).toBe(10);
  });

  it('AC-22/AC-23/AC-24: a rejected webhook record answers 200 success:false and keeps the delivery id', async () => {
    const payload = {
      action: 'opened',
      issue: {
        number: 14,
        title: 'Webhook issue 14',
        body: null,
        user: { login: 'octo' },
        html_url: 'https://github.com/acme/app/issues/14',
        labels: [],
        created_at: '2026-10-03T10:00:00Z',
      },
    };
    const deliveryId = 'vcs-issue-audit-rejected-14';
    rejectRecordingOf('system.vcs.webhook-intake');

    const response = await deliver(payload, 'issues', deliveryId).expect(200);
    expect(response.body).toMatchObject({ success: false });
    expect(await db.ticket.count({ where: { projectId, externalVcsId: 'acme/app#14' } })).toBe(0);

    // The intake swallowed the failure instead of throwing, so the controller kept the delivery id.
    await deliver(payload, 'issues', deliveryId).expect(409);
  });

  it('AC-25/AC-26/AC-27: a soft-deleted import is skipped and records nothing', async () => {
    const deleted = await db.ticket.create({
      data: {
        projectId,
        number: 900,
        type: 'TASK',
        title: 'Deleted import',
        description: null,
        status: 'CREATED',
        priority: 'MEDIUM',
        externalVcsId: 'acme/app#30',
        deletedAt: new Date('2026-10-04T00:00:00Z'),
      },
    });
    const ticketsBefore = await db.ticket.count({ where: { projectId } });
    const entriesBefore = await db.auditEntry.count({ where: { key: POLL_KEY } });
    const sync = app.get(VcsSyncService);
    const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
    const connection = await db.vcsConnection.findUniqueOrThrow({ where: { projectId } });

    const result = await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () =>
      sync.syncIssue(project, issue(30), 'polling', connection, POLL_KEY));

    expect(result.action).toBe('skipped');
    expect(await db.ticket.count({ where: { projectId } })).toBe(ticketsBefore);
    expect(await db.auditEntry.count({ where: { key: POLL_KEY } })).toBe(entriesBefore);
    expect(await importRowsOf(deleted.id, POLL_KEY)).toHaveLength(0);
  });
});
