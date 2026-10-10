import type { MockInstance } from 'vitest';
/**
 * Fleet C9 slice 1b — fleet PR-state refresher (PG), spec §3.4, §3.5, §6.
 * The forge is stubbed on the app's GitHubAppClient instance; DB, VCS repository and merge step are real.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-refresher.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { GitHubAppClient } from '../../../src/fleet/git-broker/github-app-client';
import { FleetPrStateRefresher } from '../../../src/fleet/tickets/fleet-pr-state.refresher';
import { VcsPrSyncService } from '../../../src/vcs/vcs-pr-sync.service';
import type { TicketLinkData } from '../../../src/vcs/domain/vcs.repository';
import type { VcsPrStatus } from '../../../src/vcs/types';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet PR-state refresher (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let refresher: FleetPrStateRefresher;
  let getPullRequest: MockInstance;
  let n = 0;

  const status = (over: Partial<VcsPrStatus> = {}): VcsPrStatus => ({
    number: 1, state: 'open', draft: false, merged: false, mergedAt: null, mergedBy: null, mergeSha: null, url: 'u', title: 't', ...over,
  });
  const fleetLink = async (prNumber: number) => {
    n += 1;
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    const link = await prisma.ticketLink.create({
      data: {
        ticketId: ticket.id, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr',
        source: 'fleet', jobId: job.id, prNumber, externalRef: `acme/app#${prNumber}`, prState: 'open', prUpdatedAt: new Date(0),
      },
    });
    return { ticket, link };
  };
  const linkState = async (id: string) => (await prisma.ticketLink.findUniqueOrThrow({ where: { id } })).prState;
  const fixReports = (ticketId: string) => prisma.comment.count({ where: { ticketId, type: 'FIX_REPORT' } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    refresher = app.get(FleetPrStateRefresher);
    const github = app.get(GitHubAppClient);
    vi.spyOn(github, 'mintInstallationToken').mockResolvedValue({ token: 'ghs_test', expiresAt: new Date(Date.now() + 3_600_000) });
    getPullRequest = vi.spyOn(github, 'getPullRequest');
  });
  beforeEach(async () => {
    getPullRequest.mockReset();
    await prisma.ticketLink.updateMany({ where: { source: 'fleet' }, data: { prState: 'closed' } }); // isolate each test's links
  });
  afterAll(async () => {
    await app.close();
  });

  it('a merged PR moves the ticket to VERIFY_FIX once; the next pass no longer reads it', async () => {
    const { ticket, link } = await fleetLink(21);
    getPullRequest.mockResolvedValue(status({ number: 21, state: 'closed', merged: true, mergedBy: 'dev', mergeSha: 'abc', url: link.url }));
    await expect(refresher.refresh()).resolves.toEqual(expect.objectContaining({ checked: 1, changed: 1 }));
    expect(await linkState(link.id)).toBe('merged');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('VERIFY_FIX');
    expect(await fixReports(ticket.id)).toBe(1);
    getPullRequest.mockClear();
    await refresher.refresh();
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('a deleted PR (404) closes the link without a transition', async () => {
    const { ticket, link } = await fleetLink(22);
    getPullRequest.mockResolvedValue(null);
    await refresher.refresh();
    expect(await linkState(link.id)).toBe('closed');
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('IN_PROGRESS');
  });

  it('the VCS path and the refresher seeing one merge yield one transition and one comment', async () => {
    const { ticket, link } = await fleetLink(23);
    const merged = status({ number: 23, state: 'closed', merged: true, mergedBy: 'dev', mergeSha: 'abc', url: link.url });
    getPullRequest.mockResolvedValue(merged);
    const vcsView = (await prisma.ticketLink.findUniqueOrThrow({
      where: { id: link.id },
      include: { ticket: { select: { id: true, status: true, projectId: true, number: true, externalVcsId: true } } },
    })) as TicketLinkData;
    await Promise.all([refresher.refresh(), app.get(VcsPrSyncService).applyMergedPr(vcsView, merged)]);
    expect(await linkState(link.id)).toBe('merged');
    expect(await fixReports(ticket.id)).toBe(1);
    expect(await prisma.ticketActivity.count({ where: { ticketId: ticket.id, action: 'VCS_PR_MERGED' } })).toBe(1);
  });
});
