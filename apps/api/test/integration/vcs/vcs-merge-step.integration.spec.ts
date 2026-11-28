import { canRunDbTests } from '../../helpers/test-environment';
/**
 * Fleet C9 slice 1b — one merge seen by two paths yields one transition (PG), spec §3.5, D457.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/vcs/vcs-merge-step.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { expectGuardActive, fixtureDb, withTestActor } from '../../helpers/action-context';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';

// The nax sandbox withholds host Postgres/Docker.
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('shared merge step (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let prSync: VcsPrSyncService;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    prSync = app.get(VcsPrSyncService);
  });
  afterAll(async () => {
    await app.close();
  });

  it('writes need an action context', async () => {
    await expect(expectGuardActive(app)).resolves.toBeUndefined();
  });

  it('two concurrent merge steps on one link: one VERIFY_FIX, one FIX_REPORT comment, one VCS_PR_MERGED activity', async () => {
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

    // The VCS webhook and the poll are the wrapped entries that call `applyMergedPr` in production, both
    // as `SYSTEM/vcs`; one wrapper per call keeps the two running concurrently.
    const outcomes = await Promise.all([
      withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr({ ...link, ticket: link.ticket ? { ...link.ticket, status: 'VERIFIED' } : null }, status)),
      withTestActor({ type: 'SYSTEM', id: 'vcs' }, () => prSync.applyMergedPr({ ...link, ticket: link.ticket ? { ...link.ticket, status: 'VERIFIED' } : null }, status)),
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
