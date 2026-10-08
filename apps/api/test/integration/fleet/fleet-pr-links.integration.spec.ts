/**
 * Fleet C9 slice 1b — fleet PR links on linked tickets (PG), spec §3.3, D455.
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/fleet/fleet-pr-links.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import request from 'supertest';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { PrismaFleetTicketsRepository } from '../../../src/fleet/tickets/prisma-fleet-tickets.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet PR links (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let effects: FleetJobTicketEffects;
  let n = 0;

  const ticket = async () => {
    n += 1;
    return prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
  };
  const jobFor = async (ticketIds: string[], resultPrUrl: string | null, state = 'COMPLETED') => {
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}-${ticketIds.length}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 1, resultPrUrl,
      },
    });
    await prisma.fleetJobTicket.createMany({ data: ticketIds.map((ticketId) => ({ jobId: job.id, ticketId })) });
    return job;
  };
  const links = (ticketId: string) => prisma.ticketLink.findMany({ where: { ticketId } });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(app.getHttpServer(), prisma);
    effects = app.get(FleetJobTicketEffects);
  });
  afterAll(async () => {
    await app.close();
  });

  it('creates one fleet pr link per linked ticket, once, with a TICKET_UPDATED event', async () => {
    const [a, b] = [await ticket(), await ticket()];
    const job = await jobFor([a.id, b.id], 'https://github.com/acme/app/pull/9');
    await effects.onTerminal([job.id]);
    await effects.onTerminal([job.id]);
    for (const t of [a, b]) {
      expect(await links(t.id)).toEqual([expect.objectContaining({
        url: 'https://github.com/acme/app/pull/9', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id,
        prNumber: 9, externalRef: 'acme/app#9', prState: 'open',
      })]);
      expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, action: 'TICKET_UPDATED' } })).toBe(1);
    }
  });

  it('an existing vcs link for the same URL keeps source vcs and gains the job id', async () => {
    const t = await ticket();
    const url = 'https://github.com/acme/app/pull/10';
    await prisma.ticketLink.create({ data: { ticketId: t.id, url, provider: 'github', linkType: 'pr', prNumber: 10, externalRef: 'acme/app#10', prState: 'draft' } });
    const job = await jobFor([t.id], url);
    await effects.upsertPrLinks(job.id);
    expect(await links(t.id)).toEqual([expect.objectContaining({ source: 'vcs', jobId: job.id, prState: 'draft' })]);
    expect(await prisma.ticketEvent.count({ where: { ticketId: t.id, action: 'TICKET_UPDATED' } })).toBe(0);
  });

  it('ignores a PR URL on another repo, and a job without a PR', async () => {
    const t = await ticket();
    await effects.upsertPrLinks((await jobFor([t.id], 'https://github.com/evil/fork/pull/1')).id);
    await effects.upsertPrLinks((await jobFor([t.id], null, 'FAILED')).id);
    expect(await links(t.id)).toEqual([]);
  });

  it('unlink removes the fleet PR link but not a vcs link', async () => {
    const t = await ticket();
    const job = await jobFor([t.id], 'https://github.com/acme/app/pull/11');
    await effects.upsertPrLinks(job.id);
    await prisma.ticketLink.create({ data: { ticketId: t.id, url: 'https://example.com/doc', provider: 'other', linkType: 'url' } });
    await expect(app.get(PrismaFleetTicketsRepository).unlink(job.id, t.id)).resolves.toBe(true);
    expect((await links(t.id)).map((l) => l.source)).toEqual(['vcs']);
  });

  it('the ticket detail response carries source and jobId on the fleet link', async () => {
    const t = await ticket();
    const job = await jobFor([t.id], 'https://github.com/acme/app/pull/12');
    await effects.upsertPrLinks(job.id);
    const body = data<{ links: Array<{ url: string; source: string; jobId: string | null }> }>(
      await request(app.getHttpServer()).get(`/api/projects/web/tickets/WEB-${t.number}`).set({ Authorization: `Bearer ${world.tokens.dev}` }).expect(200),
    );
    expect(body.links).toEqual([expect.objectContaining({ url: 'https://github.com/acme/app/pull/12', source: 'fleet', jobId: job.id })]);
  });
});
