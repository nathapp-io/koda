/**
 * Fleet C9 slice 1b — one merge seen by two paths yields one transition (PG), spec §3.5, D457.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/vcs/vcs-merge-step.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('shared merge step (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let prSync: VcsPrSyncService;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    prSync = app.get(VcsPrSyncService);
  });
  afterAll(async () => {
    await app.close();
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

    const outcomes = await Promise.all([prSync.applyMergedPr(link, status), prSync.applyMergedPr(link, status)]);

    expect([...outcomes].sort()).toEqual(['already-merged', 'updated']);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await prisma.comment.count({ where: { ticketId: ticket.id, type: 'FIX_REPORT' } })).toBe(1);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
  });
});
