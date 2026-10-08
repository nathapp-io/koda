/**
 * #231 — classic vs fleet PR coordination (PG). The two repository queries behind
 * the dispatch guard (`findOpenVcsPrLinks`) and the classic auto-PR yield
 * (`hasFleetOwnership`), plus the dispatch endpoint's 409/acknowledge round-trip.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/dispatch-open-pr.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet vs classic PR coordination (#231, PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let fleetTickets: PrismaFleetTicketsRepository;
  let tickets: PrismaTicketsRepository;
  let n = 0;

  const ticket = async () => {
    n += 1;
    return prisma.ticket.create({
      data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' },
    });
  };

  const openVcsLink = (ticketId: string, prNumber: number) =>
    prisma.ticketLink.create({
      data: { ticketId, url: `https://github.com/acme/app/pull/${prNumber}`, provider: 'github', linkType: 'pr', source: 'vcs', prState: 'draft' },
    });

  const jobFor = async (ticketId: string, feature: string, state: string) => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 1,
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId } });
    return job;
  };

  const dispatch = (body: Record<string, unknown>) =>
    request(server)
      .post('/api/projects/web/fleet/jobs')
      .set({ Authorization: `Bearer ${world.tokens.dev}` })
      .send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    fleetTickets = app.get(PrismaFleetTicketsRepository);
    tickets = app.get(PrismaTicketsRepository);
  });
  afterAll(async () => {
    await app.close();
  });

  it('findOpenVcsPrLinks returns open vcs pr links only', async () => {
    const t = await ticket();
    await openVcsLink(t.id, 1);
    await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://github.com/acme/app/pull/2', provider: 'github', linkType: 'pr', source: 'vcs', prState: 'merged' } });
    await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://github.com/acme/app/pull/3', provider: 'github', linkType: 'pr', source: 'fleet', prState: 'open' } });
    await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://example.com/doc', provider: 'other', linkType: 'url' } });

    await expect(fleetTickets.findOpenVcsPrLinks([t.id])).resolves.toEqual([
      { ticketId: t.id, url: 'https://github.com/acme/app/pull/1' },
    ]);
  });

  it('hasFleetOwnership is true for a fleet pr link and for an active fleet job', async () => {
    const withLink = await ticket();
    await prisma.ticketLink.create({ data: { ticketId: withLink.id, url: 'https://github.com/acme/app/pull/4', provider: 'github', linkType: 'pr', source: 'fleet', prState: 'open' } });
    await expect(tickets.hasFleetOwnership(withLink.id)).resolves.toBe(true);

    const withJob = await ticket();
    await jobFor(withJob.id, `own-${withJob.number}`, 'RUNNING');
    await expect(tickets.hasFleetOwnership(withJob.id)).resolves.toBe(true);
  });

  it('hasFleetOwnership is false for a vcs-only link or a terminal fleet job', async () => {
    const vcsOnly = await ticket();
    await openVcsLink(vcsOnly.id, 5);
    await expect(tickets.hasFleetOwnership(vcsOnly.id)).resolves.toBe(false);

    const terminal = await ticket();
    await jobFor(terminal.id, `done-${terminal.number}`, 'COMPLETED');
    await expect(tickets.hasFleetOwnership(terminal.id)).resolves.toBe(false);
  });

  it('refuses a RUN on a ticket with an open vcs PR, then accepts it when acknowledged', async () => {
    const t = await ticket();
    await openVcsLink(t.id, 6);
    const ref = `WEB-${t.number}`;

    const refused = await dispatch({ feature: 'open-pr-1', ticketRefs: [ref] }).expect(409);
    expect(JSON.stringify(refused.body)).toContain(ref);

    const accepted = data<{ job: { id: string; state: string } }>(
      await dispatch({ feature: 'open-pr-1-ack', ticketRefs: [ref], acknowledgeOpenPr: true }).expect(201),
    );
    expect(accepted.job.state).toBe('QUEUED');
  });
});
