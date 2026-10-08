/**
 * Fleet C9 slice 1b — repo-scoped VCS PR matching (PG), spec §3.6, D458, §6 regression.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-matching.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { GitHubWebhookPayload, VcsWebhookService } from '../../../src/vcs/vcs-webhook.service';
import type { VcsConnectionWithProjectDomain } from '../../../src/vcs/domain/vcs.domain';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

const closed = (number: number, owner = 'acme', name = 'app'): GitHubWebhookPayload => ({
  action: 'closed',
  pull_request: {
    number, title: 'PR', body: null, user: { login: 'dev' }, html_url: `https://github.com/${owner}/${name}/pull/${number}`,
    state: 'closed', draft: false, merged: false, merged_at: null, merged_by: null,
    base: { ref: 'main', repo: { full_name: `${owner}/${name}` } }, head: { ref: 'feat', repo: { full_name: `${owner}/${name}` } },
  },
});

describeIntegration('repo-scoped VCS PR matching (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let vcsRepo: PrismaVcsRepository;
  let webhook: VcsWebhookService;
  let connection: VcsConnectionWithProjectDomain;
  let otherRepoId: string;
  let n = 100;

  const ticket = async () => {
    n += 1;
    return prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
  };
  const fleetLinkOnOtherRepo = async (prNumber: number) => {
    const t = await ticket();
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: otherRepoId, ref: 'main', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED', leaseEpoch: 1,
      },
    });
    return prisma.ticketLink.create({
      data: {
        ticketId: t.id, url: `https://github.com/other/lib/pull/${prNumber}`, provider: 'github', linkType: 'pr',
        source: 'fleet', jobId: job.id, prNumber, externalRef: `other/lib#${prNumber}`, prState: 'open',
      },
    });
  };
  const vcsLink = async (prNumber: number, externalRef: string | null = `acme/app#${prNumber}`) => {
    const t = await ticket();
    return prisma.ticketLink.create({
      data: { ticketId: t.id, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr', prNumber, externalRef, prState: 'open' },
    });
  };
  const state = async (id: string) => (await prisma.ticketLink.findUniqueOrThrow({ where: { id } })).prState;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    vcsRepo = app.get(PrismaVcsRepository);
    webhook = app.get(VcsWebhookService);
    otherRepoId = (await prisma.fleetRepo.create({
      data: { projectId: world.projectId, provider: 'github', owner: 'other', name: 'lib', defaultBranch: 'main', githubInstallationId: BigInt(78), createdById: world.ids.root },
    })).id;
    const conn = await prisma.vcsConnection.create({
      data: { projectId: world.projectId, provider: 'github', repoOwner: 'acme', repoName: 'app', encryptedToken: 'unused', syncMode: 'webhook' },
    });
    connection = (await vcsRepo.findVcsConnectionById(conn.id)) as VcsConnectionWithProjectDomain;
  });
  afterAll(async () => {
    await app.close();
  });

  it('a webhook for PR #5 closes the connection repo link and leaves the other repo fleet link open', async () => {
    const fleet = await fleetLinkOnOtherRepo(5);
    const mine = await vcsLink(5);
    await expect(webhook.handleWebhook(connection, 'pull_request', closed(5))).resolves.toEqual({ success: true, ignored: false });
    expect(await state(mine.id)).toBe('closed');
    expect(await state(fleet.id)).toBe('open');
  });

  it('ignores a webhook when only another repo has a link with that number', async () => {
    const fleet = await fleetLinkOnOtherRepo(6);
    const result = await webhook.handleWebhook(connection, 'pull_request', closed(6));
    expect(result).toEqual(expect.objectContaining({ success: true, ignored: true }));
    expect(await state(fleet.id)).toBe('open');
  });

  it('the poll query returns the connection repo links and legacy null-ref vcs rows only', async () => {
    const fleet = await fleetLinkOnOtherRepo(7);
    const mine = await vcsLink(8);
    const legacy = await vcsLink(9, null);
    const ids = (await vcsRepo.findActiveTicketLinksWithPrs(world.projectId, connection)).map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, legacy.id]));
    expect(ids).not.toContain(fleet.id);
  });
});
