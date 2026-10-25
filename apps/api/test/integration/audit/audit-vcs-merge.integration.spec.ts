import { createHmac } from 'node:crypto';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { FleetPrStateRefresher } from '../../../src/fleet/tickets/fleet-pr-state.refresher';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

/**
 * Permissions P2 US-004 — the shared PR merge step records its link write and its eligible
 * auto-transition as `SYSTEM/vcs`, in the transaction of each write.
 *
 * Every entry is read back from `AuditEntry` through the real `AppModule` wiring: `applyMergedPr` is
 * fetched with `app.get`, the webhook is a signed `POST /api/projects/web/vcs-webhook`, and the fleet
 * path is the real `FleetPrStateRefresher` with only the forge stubbed.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/audit/audit-vcs-merge.integration.spec.ts
 */
const describeIntegration = canRunDbTests() ? describe : describe.skip;

const KEY = 'system.vcs.pr-merge-transition';
const SLUG = 'web';
const WEBHOOK = `/api/projects/${SLUG}/vcs-webhook`;
const PR_REFRESH_KEY = 'system.ticket-link.pr-refresh';

interface MergeFixture {
  ticketId: string;
  linkId: string;
  prNumber: number;
  view: TicketLinkData;
}

describeIntegration('PR merge step audit entries', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let prSync: VcsPrSyncService;
  let getPullRequest: MockInstance;
  let webhookSecret: string;
  let ticketNumber = 0;
  let prNumber = 0;
  let delivery = 0;
  let restoreRecord: (() => void) | undefined;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;

  const prUrl = (number: number): string => `https://github.com/acme/app/pull/${number}`;
  const mergedStatus = (number: number): VcsPrStatus => ({
    number, state: 'closed', draft: false, merged: true, mergedAt: new Date('2026-10-20T10:00:00Z'),
    mergedBy: 'dev', mergeSha: 'sha-dev', url: prUrl(number), title: 'Sensitive PR title',
  });

  /** A PR link of the project's VCS connection (`acme/app`) on a fresh ticket, as the merge step takes one. */
  const newLink = async (over: { ticketStatus?: string; prState?: string | null } = {}): Promise<MergeFixture> => {
    ticketNumber += 1;
    prNumber += 1;
    const number = prNumber;
    const ticket = await db.ticket.create({ data: {
      projectId: world.projectId, number: ticketNumber, type: 'TASK', title: `Merge ticket ${ticketNumber}`,
      status: over.ticketStatus ?? 'IN_PROGRESS', priority: 'MEDIUM',
    } });
    const link = await db.ticketLink.create({ data: {
      ticketId: ticket.id, url: prUrl(number), provider: 'github', linkType: 'pr',
      prNumber: number, externalRef: `acme/app#${number}`,
      prState: over.prState === undefined ? 'open' : over.prState,
    } });
    return { ticketId: ticket.id, linkId: link.id, prNumber: number, view: await linkView(link.id) };
  };

  /** A fleet PR link (job-linked, so the refresher picks it up) on an IN_PROGRESS ticket. */
  const newFleetLink = async (): Promise<MergeFixture> => {
    ticketNumber += 1;
    prNumber += 1;
    const number = prNumber;
    const ticket = await db.ticket.create({ data: {
      projectId: world.projectId, number: ticketNumber, type: 'TASK', title: `Fleet merge ticket ${ticketNumber}`,
      status: 'IN_PROGRESS', priority: 'MEDIUM',
    } });
    const job = await db.fleetJob.create({ data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `merge-audit-${number}`,
      profiles: [], maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev,
      state: 'COMPLETED', leaseEpoch: 1,
    } });
    const link = await db.ticketLink.create({ data: {
      ticketId: ticket.id, url: prUrl(number), provider: 'github', linkType: 'pr', source: 'fleet',
      jobId: job.id, prNumber: number, externalRef: `acme/app#${number}`, prState: 'open', prUpdatedAt: new Date(0),
    } });
    return { ticketId: ticket.id, linkId: link.id, prNumber: number, view: await linkView(link.id) };
  };

  const linkView = async (linkId: string): Promise<TicketLinkData> => (await db.ticketLink.findUniqueOrThrow({
    where: { id: linkId },
    include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
  })) as TicketLinkData;

  const entriesOf = (resourceId: string) => db.auditEntry.findMany({ where: { resourceId }, orderBy: { createdAt: 'asc' } });
  const prStateOf = async (linkId: string) => (await db.ticketLink.findUniqueOrThrow({ where: { id: linkId } })).prState;
  const statusOf = async (ticketId: string) => (await db.ticket.findUniqueOrThrow({ where: { id: ticketId } })).status;
  const merge = (fixture: MergeFixture) => withTestActor(
    { type: 'SYSTEM', id: 'vcs' },
    () => prSync.applyMergedPr(fixture.view, mergedStatus(fixture.prNumber)),
  );

  /** Rejects the first `record` call the predicate matches, then delegates to the real recorder. */
  const rejectFirstMatchingRecord = (matches: (input: { key: string; resourceType: string }) => boolean) => {
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    let rejected = false;
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (!rejected && matches(input)) {
        rejected = true;
        throw new Error('audit down');
      }
      await original(input);
    });
    restoreRecord = () => spy.mockRestore();
  };

  const deliverMerged = (number: number) => {
    const payload = { action: 'closed', pull_request: {
      number, title: 'Sensitive PR title', body: null, user: { login: 'octo' },
      html_url: prUrl(number), state: 'closed', draft: false, merged: true,
      merged_at: '2026-10-20T10:00:00Z', merged_by: { login: 'octo' }, merge_commit_sha: 'abc',
      base: { ref: 'main', repo: { full_name: 'acme/app' } }, head: { ref: 'feature', repo: { full_name: 'acme/app' } },
    } };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
    return request(app.getHttpServer()).post(WEBHOOK)
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature)
      .set('x-github-event', 'pull_request')
      .set('x-github-delivery', `merge-audit-${++delivery}`)
      .send(body);
  };

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    const created = await request(app.getHttpServer())
      .post(`/api/projects/${SLUG}/vcs`)
      .set({ Authorization: `Bearer ${world.tokens.root}` })
      .send({ provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_merge_audit', syncMode: 'webhook' })
      .expect(201);
    webhookSecret = data<{ webhookSecret: string }>(created).webhookSecret;

    prSync = app.get(VcsPrSyncService);
    const github = app.get(GitHubAppClient);
    vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({ token: 'ghs_test', expiresAt: new Date(Date.now() + 3_600_000) });
    getPullRequest = vi.spyOn(github, 'getPullRequest');
  });
  beforeEach(async () => {
    resetThrottle(app);
    getPullRequest.mockReset();
    // The refresher sweeps every open fleet link; close the previous tests' rows so each AC sees only its own.
    await db.ticketLink.updateMany({ where: { source: 'fleet' }, data: { prState: 'closed' } });
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

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('AC-1/AC-2/AC-3: the merge records the link write and the auto-transition as SYSTEM/vcs', async () => {
    const fixture = await newLink();

    await expect(merge(fixture)).resolves.toBe('updated');

    const linkEntries = await entriesOf(fixture.linkId);
    const ticketEntries = await entriesOf(fixture.ticketId);
    expect(linkEntries).toHaveLength(1);
    expect(linkEntries[0]).toMatchObject({
      key: KEY, resourceType: 'ticket-link', resourceId: fixture.linkId, projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'vcs', origin: 'system', summary: 'pr open -> merged',
    });
    expect(ticketEntries).toHaveLength(1);
    expect(ticketEntries[0]).toMatchObject({
      key: KEY, resourceType: 'ticket', resourceId: fixture.ticketId, projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'vcs', origin: 'system', summary: 'status: IN_PROGRESS -> VERIFY_FIX',
    });
    expect(await statusOf(fixture.ticketId)).toBe('VERIFY_FIX');
  });

  it('AC-4: a merge a user triggered is still recorded as SYSTEM/vcs', async () => {
    const fixture = await newLink();

    await expect(withTestActor(
      { type: 'USER', id: world.ids.root },
      () => prSync.applyMergedPr(fixture.view, mergedStatus(fixture.prNumber)),
    )).resolves.toBe('updated');

    const actors = [...await entriesOf(fixture.linkId), ...await entriesOf(fixture.ticketId)]
      .map(({ actorType, actorId }) => ({ actorType, actorId }));
    expect(actors).toEqual([{ actorType: 'SYSTEM', actorId: 'vcs' }, { actorType: 'SYSTEM', actorId: 'vcs' }]);
  });

  it('AC-5: two concurrent merge steps store one link entry and one ticket entry', async () => {
    const fixture = await newLink();

    const outcomes = await Promise.all([merge(fixture), merge(fixture)]);

    expect([...outcomes].sort()).toEqual(['already-merged', 'updated']);
    expect(await db.auditEntry.count({ where: { key: KEY, resourceId: fixture.linkId } })).toBe(1);
    expect(await db.auditEntry.count({ where: { key: KEY, resourceId: fixture.ticketId } })).toBe(1);
  });

  it('AC-6/AC-7: the fleet refresh records the merge as SYSTEM/vcs and no pr-refresh entry', async () => {
    const fixture = await newFleetLink();
    getPullRequest.mockResolvedValue(mergedStatus(fixture.prNumber));

    await expect(app.get(FleetPrStateRefresher).refresh()).resolves.toEqual(expect.objectContaining({ changed: 1 }));

    expect(await entriesOf(fixture.linkId)).toMatchObject([{
      key: KEY, resourceType: 'ticket-link', actorId: 'vcs', summary: 'pr open -> merged',
    }]);
    expect(await db.auditEntry.count({ where: { key: PR_REFRESH_KEY, resourceId: fixture.linkId } })).toBe(0);
    expect(await entriesOf(fixture.ticketId)).toMatchObject([{
      key: KEY, resourceType: 'ticket', actorId: 'vcs', summary: 'status: IN_PROGRESS -> VERIFY_FIX',
    }]);
    expect(await entriesOf(fixture.ticketId)).toHaveLength(1);
  });

  it('AC-8/AC-9: a signed merged webhook stores both entries without the merge author or SHA', async () => {
    const fixture = await newLink();

    await expect(deliverMerged(fixture.prNumber)).resolves.toMatchObject({ status: 200 });

    const linkEntries = await entriesOf(fixture.linkId);
    const ticketEntries = await entriesOf(fixture.ticketId);
    expect(linkEntries).toMatchObject([{ key: KEY, resourceType: 'ticket-link', summary: 'pr open -> merged' }]);
    expect(ticketEntries).toMatchObject([{ key: KEY, resourceType: 'ticket', summary: 'status: IN_PROGRESS -> VERIFY_FIX' }]);
    for (const entry of [...linkEntries, ...ticketEntries]) {
      expect(entry.summary ?? '').not.toContain('octo');
      expect(entry.summary ?? '').not.toContain('abc');
    }
  });

  it('AC-10/AC-11/AC-12: a ticket that is not IN_PROGRESS gets the link entry only', async () => {
    const fixture = await newLink({ ticketStatus: 'CREATED' });

    await expect(merge(fixture)).resolves.toBe('updated');

    expect(await entriesOf(fixture.linkId)).toMatchObject([{ key: KEY, resourceType: 'ticket-link' }]);
    expect(await entriesOf(fixture.ticketId)).toHaveLength(0);
  });

  it('AC-23: a merged PR on a ticket that is not IN_PROGRESS leaves the ticket status unchanged', async () => {
    const fixture = await newLink({ ticketStatus: 'DONE' });

    await expect(merge(fixture)).resolves.toBe('updated');

    expect(await statusOf(fixture.ticketId)).toBe('DONE');
  });

  it('AC-13/AC-14: a link already merged adds no entry', async () => {
    const fixture = await newLink({ prState: 'merged' });

    await expect(merge(fixture)).resolves.toBe('already-merged');

    expect(await entriesOf(fixture.linkId)).toHaveLength(0);
    expect(await entriesOf(fixture.ticketId)).toHaveLength(0);
  });

  it('AC-15/AC-16/AC-17: a rejected link record rolls the merge back and rejects', async () => {
    const fixture = await newLink();
    rejectFirstMatchingRecord((input) => input.key === KEY);

    await expect(merge(fixture)).rejects.toThrow('audit down');

    expect(await prStateOf(fixture.linkId)).toBe('open');
    expect(await statusOf(fixture.ticketId)).toBe('IN_PROGRESS');
    expect(await entriesOf(fixture.linkId)).toHaveLength(0);
    expect(await entriesOf(fixture.ticketId)).toHaveLength(0);
  });

  it('AC-18/AC-19/AC-20/AC-21: a rejected transition record keeps the merge and rolls the transition back', async () => {
    const fixture = await newLink();
    rejectFirstMatchingRecord((input) => input.resourceType === 'ticket');

    await expect(merge(fixture)).resolves.toBe('updated');

    expect(await prStateOf(fixture.linkId)).toBe('merged');
    expect(await entriesOf(fixture.linkId)).toMatchObject([{ key: KEY, resourceType: 'ticket-link' }]);
    expect(await statusOf(fixture.ticketId)).toBe('IN_PROGRESS');
    expect(await db.comment.count({ where: { ticketId: fixture.ticketId, type: 'FIX_REPORT' } })).toBe(0);
  });

  it('AC-24/AC-25: a rejected transition record is logged, not thrown, and stores no ticket entry', async () => {
    const fixture = await newLink();
    rejectFirstMatchingRecord((input) => input.resourceType === 'ticket');
    const error = vi.mocked(Logger.prototype.error);
    error.mockClear();

    await expect(merge(fixture)).resolves.toBe('updated');

    const logged = error.mock.calls.map(([message]) => String(message)).filter((message) => message.includes('Auto-transition failed for ticket'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(fixture.ticketId);
    expect(logged[0]).toContain('audit down');
    expect(await db.auditEntry.count({ where: { key: KEY, resourceId: fixture.ticketId } })).toBe(0);
  });
});
