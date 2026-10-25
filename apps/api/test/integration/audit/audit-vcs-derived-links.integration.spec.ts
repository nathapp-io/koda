/**
 * Permissions P2 US-005 — extracted branch/commit links and the fleet ticket effects are audited
 * (spec AC1–AC14 and the story's failure table).
 *
 * Both writers are derived writes: `VcsLinkExtractorService` runs inside whichever entry point synced
 * the PR, and `FleetJobTicketEffects` runs after a job ends as the runner, the sweeper or the ingest
 * drain. So each AC enters through the booted `AppModule` (`app.get(...)`) inside `withTestActor` —
 * the context production has at that moment — and asserts the stored `AuditEntry` row, which proves
 * the writer reached the real recorder rather than a stub.
 */
import { Logger } from '@nestjs/common';
import type { NathApplication } from '@nathapp/nestjs-app';
import { Prisma, type PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { encryptToken } from '../../../src/common/utils/encryption.util';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { VcsLinkExtractorService } from '../../../src/vcs/vcs-link-extractor.service';
import type { VcsConnectionDomain } from '../../../src/vcs/domain/vcs.domain';
import type { ActionActor } from '../../../src/action-context/action-context';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { insertRunner, seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';

// The provider is stubbed (no network); the rest of the factory stays real.
vi.mock('../../../src/vcs/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/vcs/factory')>();
  return { ...actual, createVcsProvider: vi.fn() };
});

import { createVcsProvider } from '../../../src/vcs/factory';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const KEY = 'ab'.repeat(32);
const BRANCH_URL = (branch: string) => `https://github.com/acme/app/tree/${branch}`;

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

interface TicketRow {
  id: string;
  number: number;
}

describeIntegration('derived VCS and fleet writes are audited (real AppModule)', () => {
  vi.setConfig({ testTimeout: 120_000 });
  let app: NathApplication;
  let db: PrismaClient;
  let world: FleetHttpWorld;
  let project: { id: string; key: string };
  let connection: VcsConnectionDomain;
  let extractor: VcsLinkExtractorService;
  let effects: FleetJobTicketEffects;
  let runnerId: string;
  let seq = 0;
  let restoreRecord: (() => void) | undefined;
  const previousKey = process.env.VCS_ENCRYPTION_KEY;
  const provider = {
    getPullRequestStatus: vi.fn(),
    listPrCommits: vi.fn(),
    fetchIssue: vi.fn(),
    fetchIssues: vi.fn(),
    testConnection: vi.fn(),
  };
  const asRunner: ActionActor = { type: 'RUNNER', id: 'placeholder' };

  const refOf = (ticket: TicketRow): string => `${project.key}-${ticket.number}`;
  const prStatus = (number: number) => ({
    number, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null,
    url: `https://github.com/acme/app/pull/${number}`, title: 'Sensitive PR title',
  });
  const commitNaming = (ticket: TicketRow, sha = 'abc123') => ({
    sha, message: `${refOf(ticket)}: fix the thing`, authorLogin: 'octo',
    url: `https://github.com/acme/app/commit/${sha}`, date: new Date('2026-10-01T00:00:00Z'),
  });

  const newTicket = async (): Promise<TicketRow> => {
    seq += 1;
    return db.ticket.create({
      data: { projectId: world.projectId, number: seq, type: 'TASK', title: `T${seq}`, status: 'IN_PROGRESS' },
    });
  };
  const newJob = async (
    tickets: readonly TicketRow[],
    state: string,
    extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {},
  ) => {
    seq += 1;
    const job = await db.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `derived-${seq}`,
        profiles: [], maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev,
        state, leaseEpoch: 1, runnerId, ...extra,
      },
    });
    await db.fleetJobTicket.createMany({ data: tickets.map((ticket) => ({ jobId: job.id, ticketId: ticket.id })) });
    return job;
  };
  const linkedJob = async (
    state: string,
    ticketCount = 1,
    extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {},
  ) => {
    const tickets: TicketRow[] = [];
    for (let i = 0; i < ticketCount; i += 1) tickets.push(await newTicket());
    return { job: await newJob(tickets, state, extra), tickets };
  };

  const linkEntries = async (linkIds: readonly string[]): Promise<AuditRow[]> =>
    (await db.auditEntry.findMany({
      where: { resourceId: { in: [...linkIds] }, key: 'ticket.link.add' }, orderBy: { createdAt: 'asc' },
    })) as AuditRow[];
  const commentEntries = async (commentIds: readonly string[]): Promise<AuditRow[]> =>
    (await db.auditEntry.findMany({
      where: { resourceId: { in: [...commentIds] }, key: 'comment.create' }, orderBy: { createdAt: 'asc' },
    })) as AuditRow[];
  const derivedEntryCount = (): Promise<number> =>
    db.auditEntry.count({
      where: { projectId: world.projectId, key: { in: ['comment.create', 'ticket.link.add'] } },
    });
  const linksOf = (ticketId: string) => db.ticketLink.findMany({ where: { ticketId } });
  const commentsOf = (ticketId: string) => db.comment.findMany({ where: { ticketId } });

  const extractAs = (actor: ActionActor, ticket: TicketRow, branchName: string, prNumber: number) =>
    withTestActor(actor, () => extractor.extractLinksFromPr(project, { ...ticket, externalVcsId: null }, connection, KEY, branchName, prNumber));
  const onTerminalAs = (actor: ActionActor, jobIds: readonly string[]) =>
    withTestActor(actor, () => effects.onTerminal(jobIds));
  const upsertPrLinksAs = (actor: ActionActor, jobId: string) =>
    withTestActor(actor, () => effects.upsertPrLinks(jobId));

  /** Makes `record` reject for `key` (every call) or only its first, so one AC's spy cannot leak on. */
  const rejectRecordsOf = (key: string, mode: 'all' | 'first' = 'all'): void => {
    const recorder = app.get(AuditRecorder);
    const original = recorder.record.bind(recorder);
    let calls = 0;
    const spy = vi.spyOn(recorder, 'record').mockImplementation(async (input) => {
      if (input.key === key) {
        calls += 1;
        if (mode === 'all' || calls === 1) throw new Error('audit down');
      }
      await original(input);
    });
    restoreRecord = () => spy.mockRestore();
  };
  const warnings = (): string => {
    const warn = vi.mocked(Logger.prototype.warn);
    return warn.mock.calls.map(([message]) => String(message)).join('\n');
  };
  const clearWarnings = (): void => {
    vi.mocked(Logger.prototype.warn).mockClear();
  };

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = KEY;
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    world = await seedFleetHttpWorld(app.getHttpServer(), db);
    project = await db.project.findUniqueOrThrow({ where: { id: world.projectId } });
    connection = {
      id: 'conn-1', projectId: world.projectId, provider: 'github', repoOwner: 'acme', repoName: 'app',
      encryptedToken: encryptToken('ghp_derived_links', KEY), syncMode: 'webhook', allowedAuthors: '[]',
      pollingIntervalMs: 300_000, webhookSecret: null, lastSyncedAt: null, isActive: true,
      createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-01T00:00:00Z'),
    };
    extractor = app.get(VcsLinkExtractorService);
    effects = app.get(FleetJobTicketEffects);
    runnerId = (await insertRunner(db)).id;
    asRunner.id = runnerId;
  });

  beforeEach(() => {
    provider.getPullRequestStatus.mockReset();
    provider.listPrCommits.mockReset();
    provider.listPrCommits.mockResolvedValue([]);
    vi.mocked(createVcsProvider).mockReturnValue(provider as never);
    clearWarnings();
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

  // ---------------------------------------------------------------------------
  // VcsLinkExtractorService — ticket.link.add, as the current actor
  // ---------------------------------------------------------------------------

  it('AC-1/AC-2: a created branch link and a created commit link are audited once, for the caller', async () => {
    const ticket = await newTicket();
    provider.getPullRequestStatus.mockResolvedValue(prStatus(101));
    provider.listPrCommits.mockResolvedValue([commitNaming(ticket, 'sha-ac1')]);

    await extractAs({ type: 'USER', id: world.ids.root }, ticket, 'feat/x', 101);

    const links = await linksOf(ticket.id);
    expect(links.map((link) => link.linkType).sort()).toEqual(['branch', 'commit']);
    const branch = links.find((link) => link.linkType === 'branch');
    const commit = links.find((link) => link.linkType === 'commit');
    expect(branch?.url).toBe(BRANCH_URL('feat/x'));
    expect(commit?.url).toBe('https://github.com/acme/app/commit/sha-ac1');

    const rows = await linkEntries(links.map((link) => link.id));
    expect(rows).toHaveLength(2);
    // One entry for the branch link id, one for the commit link id.
    expect(rows.map((row) => row.resourceId).sort()).toEqual([branch?.id, commit?.id].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        key: 'ticket.link.add', resourceType: 'ticket-link', projectId: world.projectId,
        actorType: 'USER', actorId: world.ids.root, summary: `on ${refOf(ticket)}`,
        // No entry in this feature sets onBehalfOf: the derived write is attributed to the current actor.
        onBehalfOfType: null, onBehalfOfId: null,
      });
      // Summaries never carry a URL, a title or a branch/commit message.
      expect(row.summary).not.toContain('https://');
      expect(row.summary).not.toContain('feat/x');
      expect(row.summary).not.toContain('Sensitive PR title');
      expect(row.summary).not.toContain('fix the thing');
    }

    // AC-2: the same extraction again refreshes both links and records nothing new.
    await extractAs({ type: 'USER', id: world.ids.root }, ticket, 'feat/x', 101);
    expect(await linksOf(ticket.id)).toHaveLength(2);
    expect(await linkEntries(links.map((link) => link.id))).toHaveLength(2);
  });

  it('AC-3: an extraction run under the poller context records SYSTEM/vcs, not a user', async () => {
    const ticket = await newTicket();
    provider.getPullRequestStatus.mockResolvedValue(prStatus(102));

    await extractAs({ type: 'SYSTEM', id: 'vcs' }, ticket, 'feat/system', 102);

    const links = await linksOf(ticket.id);
    expect(links).toHaveLength(1);
    const rows = await linkEntries(links.map((link) => link.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'ticket.link.add', projectId: world.projectId,
      actorType: 'SYSTEM', actorId: 'vcs', summary: `on ${refOf(ticket)}`,
    });
  });

  it('AC-4/AC-5: a rejected link record fails the extraction and leaves no link behind', async () => {
    const ticket = await newTicket();
    provider.getPullRequestStatus.mockResolvedValue(prStatus(103));
    provider.listPrCommits.mockResolvedValue([commitNaming(ticket, 'sha-ac4')]);
    rejectRecordsOf('ticket.link.add');

    await expect(extractAs({ type: 'USER', id: world.ids.root }, ticket, 'feat/rejected', 103))
      .rejects.toThrow('audit down');

    // AC-5: the branch link's own transaction rolled back with its entry.
    expect(await db.ticketLink.count({ where: { ticketId: ticket.id, url: BRANCH_URL('feat/rejected') } })).toBe(0);
    expect(await linksOf(ticket.id)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // FleetJobTicketEffects — comment.create and ticket.link.add for the job's tickets
  // ---------------------------------------------------------------------------

  it('AC-6/AC-7: a FAILED job audits its failure comment once, as the runner that reported it', async () => {
    const { job, tickets } = await linkedJob('FAILED', 1, { stateReason: 'exit 1' });
    const [ticket] = tickets;

    await onTerminalAs(asRunner, [job.id]);

    const comments = await commentsOf(ticket.id);
    expect(comments).toHaveLength(1);
    const rows = await commentEntries([comments[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'comment.create', resourceType: 'comment', resourceId: comments[0].id, projectId: job.projectId,
      actorType: 'RUNNER', actorId: runnerId, summary: `on ${refOf(ticket)}`,
    });

    // AC-7: the same attempt again claims nothing, writes no comment and records nothing.
    await onTerminalAs(asRunner, [job.id]);
    expect(await commentsOf(ticket.id)).toHaveLength(1);
    expect(await commentEntries([comments[0].id])).toHaveLength(1);
  });

  it('AC-8: the sweeper\'s context records its failure comment as SYSTEM/job', async () => {
    const { job, tickets } = await linkedJob('FAILED', 1, { stateReason: 'runner silent' });
    const [ticket] = tickets;

    await onTerminalAs({ type: 'SYSTEM', id: 'job' }, [job.id]);

    const comments = await commentsOf(ticket.id);
    expect(comments).toHaveLength(1);
    const rows = await commentEntries([comments[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'comment.create', projectId: job.projectId,
      actorType: 'SYSTEM', actorId: 'job', summary: `on ${refOf(ticket)}`,
    });
  });

  it('AC-9: a COMPLETED job without a PR records nothing for its ticket', async () => {
    const { job, tickets } = await linkedJob('COMPLETED', 1);
    const [ticket] = tickets;
    const before = await derivedEntryCount();

    await onTerminalAs(asRunner, [job.id]);

    expect(await commentsOf(ticket.id)).toHaveLength(0);
    expect(await linksOf(ticket.id)).toHaveLength(0);
    expect(await derivedEntryCount()).toBe(before);
  });

  it('AC-10/AC-11: a created fleet PR link is audited once, keyed on its own id', async () => {
    const url = 'https://github.com/acme/app/pull/77';
    const { job, tickets } = await linkedJob('COMPLETED', 1, { resultPrUrl: url });
    const [ticket] = tickets;

    await upsertPrLinksAs(asRunner, job.id);

    const links = await linksOf(ticket.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url, source: 'fleet', jobId: job.id });
    const rows = await linkEntries([links[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: links[0].id, projectId: job.projectId,
      actorType: 'RUNNER', actorId: runnerId, summary: `on ${refOf(ticket)}`,
    });

    // AC-11: the link already exists, so the second call only repoints it and records nothing.
    await upsertPrLinksAs(asRunner, job.id);
    expect(await linksOf(ticket.id)).toHaveLength(1);
    expect(await linkEntries([links[0].id])).toHaveLength(1);
  });

  it('AC-12/AC-13: an existing vcs link gains the job id and is not audited as a creation', async () => {
    const ticket = await newTicket();
    const url = 'https://github.com/acme/app/pull/78';
    const existing = await db.ticketLink.create({
      data: {
        ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 78,
        externalRef: 'acme/app#78', prState: 'draft',
      },
    });
    const job = await newJob([ticket], 'COMPLETED', { resultPrUrl: url });

    await upsertPrLinksAs(asRunner, job.id);

    // AC-12: the update branch ran (bookkeeping, plan P4: latest job wins).
    expect(await db.ticketLink.findUniqueOrThrow({ where: { id: existing.id } }))
      .toMatchObject({ jobId: job.id, source: 'vcs', prState: 'draft' });
    // AC-13: no creation, no entry.
    expect(await linkEntries([existing.id])).toHaveLength(0);
  });

  it('AC-14/AC-15/AC-16: one ticket\'s failed comment record rolls back only that ticket', async () => {
    const first = await linkedJob('FAILED', 1, { stateReason: 'first' });
    const second = await linkedJob('FAILED', 1, { stateReason: 'second' });
    rejectRecordsOf('comment.create', 'first');

    await expect(onTerminalAs(asRunner, [first.job.id, second.job.id])).resolves.toBeUndefined();

    // AC-15: the failed record rolled the comment back.
    expect(await commentsOf(first.tickets[0].id)).toHaveLength(0);
    // AC-16: the next job still ran.
    const comments = await commentsOf(second.tickets[0].id);
    expect(comments).toHaveLength(1);
    const rows = await commentEntries([comments[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'comment.create', actorType: 'RUNNER', actorId: runnerId });
  });

  it('AC-19/AC-20: the next ticket of the same job is commented and the failure is logged', async () => {
    const { job, tickets } = await linkedJob('FAILED', 2, { stateReason: 'exit 2' });
    rejectRecordsOf('comment.create', 'first');

    await expect(onTerminalAs(asRunner, [job.id])).resolves.toBeUndefined();

    expect(await commentsOf(tickets[0].id)).toHaveLength(0);
    const comments = await commentsOf(tickets[1].id);
    expect(comments).toHaveLength(1);
    expect(await commentEntries([comments[0].id])).toHaveLength(1);

    const log = warnings();
    expect(log).toContain('comment on ticket');
    expect(log).toContain(refOf(tickets[0]));
    expect(log).toContain('audit down');
  });

  it('AC-21/AC-22: a rejected PR-link record leaves no new link and is logged', async () => {
    const { job, tickets } = await linkedJob('COMPLETED', 1, { resultPrUrl: 'https://github.com/acme/app/pull/79' });
    rejectRecordsOf('ticket.link.add');

    await expect(upsertPrLinksAs(asRunner, job.id)).resolves.toBeUndefined();

    expect(await linksOf(tickets[0].id)).toHaveLength(0);
    const log = warnings();
    expect(log).toContain('PR link on ticket');
    expect(log).toContain(refOf(tickets[0]));
    expect(log).toContain('audit down');
  });

  it('AC-23: the next ticket of the same job still receives its PR link and its entry', async () => {
    const { job, tickets } = await linkedJob('COMPLETED', 2, { resultPrUrl: 'https://github.com/acme/app/pull/80' });
    rejectRecordsOf('ticket.link.add', 'first');

    await expect(upsertPrLinksAs(asRunner, job.id)).resolves.toBeUndefined();

    expect(await linksOf(tickets[0].id)).toHaveLength(0);
    const links = await linksOf(tickets[1].id);
    expect(links).toHaveLength(1);
    const rows = await linkEntries([links[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ticket.link.add', summary: `on ${refOf(tickets[1])}` });
  });

  it('AC-24: a later job\'s PR link is still created and audited after an earlier one fails', async () => {
    const first = await linkedJob('COMPLETED', 1, { resultPrUrl: 'https://github.com/acme/app/pull/81' });
    const second = await linkedJob('COMPLETED', 1, { resultPrUrl: 'https://github.com/acme/app/pull/82' });
    rejectRecordsOf('ticket.link.add', 'first');

    await expect(onTerminalAs(asRunner, [first.job.id, second.job.id])).resolves.toBeUndefined();

    expect(await linksOf(first.tickets[0].id)).toHaveLength(0);
    const links = await linksOf(second.tickets[0].id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ url: 'https://github.com/acme/app/pull/82', jobId: second.job.id });
    const rows = await linkEntries([links[0].id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'ticket.link.add', summary: `on ${refOf(second.tickets[0])}` });
  });
});
