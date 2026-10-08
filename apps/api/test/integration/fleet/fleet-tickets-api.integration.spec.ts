/**
 * Fleet C9 slice 1a — GET/DELETE /projects/:slug/tickets/:ref/fleet-jobs (PG), spec §2.2-§2.3.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '../../../src/generated/prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('ticket fleet jobs API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let ticketId: string;
  let jobId: string;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const url = (ref: string, job = '') => `/api/projects/web/tickets/${ref}/fleet-jobs${job ? `/${job}` : ''}`;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: 1, type: 'TASK', title: 'T1' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: 'f', profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state: 'COMPLETED',
        resultBranch: 'feat/f', resultPrUrl: 'https://github.com/acme/app/pull/7', costSpentUsd: new Prisma.Decimal('0.5'),
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    await prisma.ticketLink.create({
      data: { ticketId: ticket.id, url: 'https://github.com/acme/app/pull/7', provider: 'github', linkType: 'pr', source: 'fleet', jobId: job.id },
    });
    ticketId = ticket.id;
    jobId = job.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('lists the ticket\'s jobs for a viewer, by KEY-N in any case', async () => {
    const rows = data<Array<{ id: string; resultPrUrl: string; costUsd: string }>>(await request(server).get(url('web-1')).set(auth('viewer')).expect(200));
    expect(rows).toEqual([expect.objectContaining({ id: jobId, resultPrUrl: 'https://github.com/acme/app/pull/7', costUsd: '0.5000' })]);
  });

  it('refuses outsiders and unknown tickets', async () => {
    await request(server).get(url('WEB-1')).set(auth('outsider')).expect(403);
    await request(server).get(url('WEB-404')).set(auth('viewer')).expect(404);
  });

  it('lets only DEVELOPER+ unlink; unlink removes the fleet PR link; a second unlink is 404', async () => {
    await request(server).delete(url('WEB-1', jobId)).set(auth('viewer')).expect(403);
    await request(server).delete(url('WEB-1', jobId)).set(auth('dev')).expect(204);
    expect(await prisma.fleetJobTicket.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.ticketLink.count({ where: { ticketId } })).toBe(0);
    expect(await prisma.fleetJob.count({ where: { id: jobId } })).toBe(1);
    await request(server).delete(url('WEB-1', jobId)).set(auth('dev')).expect(404);
    expect(data<unknown[]>(await request(server).get(url('WEB-1')).set(auth('viewer')).expect(200))).toEqual([]);
  });
});
