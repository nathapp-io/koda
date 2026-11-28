import { createHmac } from 'node:crypto';
import request from 'supertest';
import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet C9 slice 1b — one merge seen by two paths yields one transition (PG), spec §3.5, D457.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/vcs/vcs-merge-step.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetHttpWorld, type FleetHttpWorld } from '../../helpers/fleet-fixtures';
import { bootHttpApp, data, resetThrottle } from '../../helpers/http-app';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsConnectionDomain } from '../../../src/vcs/domain/vcs.domain';
import type { VcsPrStatus } from '../../../src/vcs/types';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('shared merge step (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let prSync: VcsPrSyncService;
  let vcsRepo: PrismaVcsRepository;
  let world: FleetHttpWorld;
  let connection: VcsConnectionDomain;
  let webhookSecret: string;
  const previousEncryptionKey = process.env.VCS_ENCRYPTION_KEY;
  const server = () => app.getHttpServer();
  const rootAuth = () => ({ Authorization: `Bearer ${world.tokens.root}` });

  beforeAll(async () => {
    await resetDb();
    process.env.VCS_ENCRYPTION_KEY = 'ab'.repeat(32);
    app = await bootHttpApp({ registrationEnabled: true });
    prisma = fixtureDb(app);
    world = await seedFleetHttpWorld(server(), prisma);
    const created = await request(server()).post('/api/projects/web/vcs').set(rootAuth()).send({
      provider: 'github', repoOwner: 'acme', repoName: 'app', token: 'ghp_fixture', syncMode: 'webhook',
    }).expect(201);
    webhookSecret = data<{ webhookSecret: string }>(created).webhookSecret;
    prSync = app.get(VcsPrSyncService);
    vcsRepo = app.get(PrismaVcsRepository);
    const foundConnection = await vcsRepo.findVcsConnectionByProjectId(world.projectId);
    if (!foundConnection) throw new Error('Expected seeded VCS connection');
    connection = foundConnection;
  }, 60000);
  afterAll(async () => {
    await app.close();
    if (previousEncryptionKey === undefined) delete process.env.VCS_ENCRYPTION_KEY;
    else process.env.VCS_ENCRYPTION_KEY = previousEncryptionKey;
  });

  beforeEach(() => resetThrottle(app));
  afterEach(() => vi.restoreAllMocks());

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('selects while VERIFIED, starts over HTTP, then applies the synthetic merged poll result', async () => {
    const ticket = data<{ id: string; ref: string }>(await request(server()).post('/api/projects/web/tickets')
      .set(rootAuth()).send({ type: 'TASK', title: 'verified PR candidate' }).expect(201));
    await request(server()).post(`/api/projects/web/tickets/${ticket.ref}/verify`).set(rootAuth()).send({ body: 'verified' }).expect(200);
    const url = 'https://github.com/acme/app/pull/31';
    const link = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 31, externalRef: 'acme/app#31', prState: 'open' },
    });
    const candidates = await vcsRepo.findActiveTicketLinksWithPrs(world.projectId, connection);
    const selected = candidates.find((candidate) => candidate.id === link.id);
    expect(selected?.ticket?.status).toBe('VERIFIED');

    await request(server()).post(`/api/projects/web/tickets/${ticket.ref}/start`).set(rootAuth()).send({}).expect(200);
    const factory = await import('../../../src/vcs/factory');
    vi.spyOn(factory, 'createVcsProvider').mockReturnValue({
      getPullRequestStatus: vi.fn().mockResolvedValue({
        number: 31, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev',
        mergeSha: 'poll-sha', url, title: 'merged poll result',
      }),
    } as unknown as ReturnType<typeof factory.createVcsProvider>);

    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.syncPrStatus(
      { id: world.projectId, key: 'WEB' }, connection, 'ab'.repeat(32), 'system.vcs.poll-issues',
    ));

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: link.id } })).prState).toBe('merged');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(1);
  });

  it('delivers one merge through polling and then webhook entry points with one set of durable effects', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { id: world.projectId } });
    const previousTicketNumber = await prisma.ticket.aggregate({ where: { projectId: project.id }, _max: { number: true } });
    const ticket = await prisma.ticket.create({ data: { projectId: project.id, number: (previousTicketNumber._max.number ?? 0) + 1, type: 'TASK', title: 'dual delivery', status: 'IN_PROGRESS' } });
    const number = 32;
    const url = `https://github.com/acme/app/pull/${number}`;
    const link = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: number, externalRef: `acme/app#${number}`, prState: 'open' },
    });
    const candidates = await vcsRepo.findActiveTicketLinksWithPrs(project.id, connection);
    expect(candidates.some((candidate) => candidate.id === link.id)).toBe(true);
    const factory = await import('../../../src/vcs/factory');
    vi.spyOn(factory, 'createVcsProvider').mockReturnValue({
      getPullRequestStatus: vi.fn().mockResolvedValue({
        number, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev',
        mergeSha: 'shared-sha', url, title: 'shared result',
      }),
    } as unknown as ReturnType<typeof factory.createVcsProvider>);
    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.syncPrStatus(
      { id: project.id, key: project.key }, connection, 'ab'.repeat(32), 'system.vcs.poll-issues',
    ));

    const payload = { action: 'closed', pull_request: {
      number, title: 'shared result', body: null, user: { login: 'dev' }, html_url: url,
      state: 'closed', draft: false, merged: true, merged_at: new Date().toISOString(),
      merged_by: { login: 'dev' }, merge_commit_sha: 'shared-sha',
      base: { ref: 'main', repo: { full_name: 'acme/app' } }, head: { ref: 'feature', repo: { full_name: 'acme/app' } },
    } };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
    await request(server()).post('/api/projects/web/vcs-webhook').set('Content-Type', 'application/json')
      .set('x-hub-signature-256', signature).set('x-github-event', 'pull_request')
      .set('x-github-delivery', 'merge-step-poll-webhook').send(body).expect(200);

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: link.id } })).prState).toBe('merged');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(1);
    expect(await prisma.auditEntry.count({ where: { key: 'system.vcs.pr-merge-transition', resourceType: 'ticket', resourceId: ticket.id } })).toBe(1);
  });

  it('two concurrent direct merge-step applications produce one transition and one of each record', async () => {
    const project = await prisma.project.create({ data: { name: 'merge', slug: 'merge', key: 'MRG' } });
    const ticket = await prisma.ticket.create({ data: { projectId: project.id, number: 1, type: 'TASK', title: 'T1', status: 'IN_PROGRESS' } });
    const url = 'https://github.com/acme/app/pull/3';
    const created = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 3, externalRef: 'acme/app#3', prState: 'open' },
    });
    const link = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: created.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    const status: VcsPrStatus = {
      number: 3, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev', mergeSha: 'abc', url, title: 'PR',
    };

    // Pin the DB row-lock/CAS behavior under simultaneous calls; the separate polling/webhook test
    // above drives each production entry point end to end.
    const outcomes = await Promise.all([
      withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr(link, status)),
      withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr(link, status)),
    ]);

    expect([...outcomes].sort()).toEqual(['already-merged', 'updated']);
    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: created.id } })).prState).toBe('merged');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(1);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
    expect(await prisma.auditEntry.count({
      where: { key: 'system.vcs.pr-merge-transition', resourceType: 'ticket', resourceId: ticket.id },
    })).toBe(1);
  });

  it('does not report a merge when the live ticket has left IN_PROGRESS', async () => {
    const project = await prisma.project.create({ data: { name: 'left progress', slug: 'left-progress', key: 'LPR' } });
    const ticket = await prisma.ticket.create({ data: { projectId: project.id, number: 1, type: 'TASK', title: 'T1', status: 'IN_PROGRESS' } });
    const url = 'https://github.com/acme/app/pull/4';
    const created = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 4, externalRef: 'acme/app#4', prState: 'open' },
    });
    const link = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: created.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'VERIFIED' } });
    const status: VcsPrStatus = {
      number: 4, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev', mergeSha: 'def', url, title: 'PR',
    };

    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr(link, status));

    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFIED');
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(0);
  });

  it('does not report a merge for a soft-deleted linked ticket', async () => {
    const project = await prisma.project.create({ data: { name: 'deleted ticket', slug: 'deleted-ticket', key: 'DTP' } });
    const ticket = await prisma.ticket.create({ data: { projectId: project.id, number: 1, type: 'TASK', title: 'T1', status: 'IN_PROGRESS' } });
    const url = 'https://github.com/acme/app/pull/5';
    const created = await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url, provider: 'github', linkType: 'pr', prNumber: 5, externalRef: 'acme/app#5', prState: 'open' },
    });
    const link = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: created.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    await prisma.ticket.update({ where: { id: ticket.id }, data: { deletedAt: new Date() } });
    const status: VcsPrStatus = {
      number: 5, state: 'closed', draft: false, merged: true, mergedAt: new Date(), mergedBy: 'dev', mergeSha: 'ghi', url, title: 'PR',
    };

    await withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr(link, status));

    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(0);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(0);
  });
});
