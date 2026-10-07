/**
 * Fleet C9 slice 1a — dispatch with ticketRefs, job detail tickets (PG), spec §2.1-§2.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-dispatch.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet dispatch with tickets (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let number = 0;
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });
  const dispatch = (body: Record<string, unknown>) =>
    request(server).post('/api/projects/web/fleet/jobs').set(auth('dev')).send({ repoId: world.repoId, command: 'RUN', maxCostUsd: 5, ...body });
  const ticket = async (status = 'CREATED', projectId = world.projectId) => {
    number += 1;
    return prisma.ticket.create({ data: { projectId, number, type: 'TASK', title: `T${number}`, status } });
  };

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
  });
  afterAll(async () => {
    await app.close();
  });

  it('links every ticket and returns them on the dispatch result and the job detail', async () => {
    const [a, b] = [await ticket(), await ticket('VERIFIED')];
    const res = data<{ job: { id: string; tickets: Array<{ ref: string }> } }>(
      await dispatch({ feature: 'two', ticketRefs: [`web-${a.number}`, `WEB-${b.number}`] }).expect(201),
    );
    expect(res.job.tickets.map((t) => t.ref)).toEqual([`WEB-${a.number}`, `WEB-${b.number}`]);
    expect(await prisma.fleetJobTicket.count({ where: { jobId: res.job.id } })).toBe(2);
    const detail = data<{ tickets: Array<{ ref: string; title: string; status: string }> }>(
      await request(server).get(`/api/projects/web/fleet/jobs/${res.job.id}`).set(auth('viewer')).expect(200),
    );
    expect(detail.tickets.map((t) => t.ref)).toEqual([`WEB-${a.number}`, `WEB-${b.number}`]);
    const list = data<{ records: Array<{ id: string; tickets: unknown }> }>(
      await request(server).get('/api/projects/web/fleet/jobs').set(auth('viewer')).expect(200),
    );
    expect(list.records.find((j) => j.id === res.job.id)?.tickets).toBeNull();
  });

  it.each([
    ['an unknown ref', async () => 'WEB-999'],
    ['a CLOSED ticket', async () => `WEB-${(await ticket('CLOSED')).number}`],
    ["another project's ref", async () => 'OPS-1'],
  ])('answers 400 naming %s and creates no job', async (_label, refOf) => {
    const ref = await refOf();
    const before = await prisma.fleetJob.count();
    const res = await dispatch({ feature: `bad-${number}`, ticketRefs: [ref] }).expect(400);
    expect(JSON.stringify(res.body)).toContain(`ticket ${ref}`);
    expect(await prisma.fleetJob.count()).toBe(before);
  });

  it('leaves no links when the dispatch itself fails (409 duplicate feature)', async () => {
    const t = await ticket();
    await dispatch({ feature: 'dup-c9' }).expect(201);
    await dispatch({ feature: 'dup-c9', ticketRefs: [`WEB-${t.number}`] }).expect(409);
    expect(await prisma.fleetJobTicket.count({ where: { ticketId: t.id } })).toBe(0);
  });

  it('answers 400 for more than 20 refs', async () => {
    await dispatch({ feature: 'many', ticketRefs: Array.from({ length: 21 }, (_, i) => `WEB-${i + 1}`) }).expect(400);
  });

  it('a RUN starts CREATED and VERIFIED tickets and leaves others; a PLAN starts none', async () => {
    const [created, verified, fixing] = [await ticket(), await ticket('VERIFIED'), await ticket('VERIFY_FIX')];
    await dispatch({ feature: 'starts', ticketRefs: [created, verified, fixing].map((t) => `WEB-${t.number}`) }).expect(201);
    const statuses = await prisma.ticket.findMany({ where: { id: { in: [created.id, verified.id, fixing.id] } }, orderBy: { number: 'asc' } });
    expect(statuses.map((s) => s.status)).toEqual(['IN_PROGRESS', 'IN_PROGRESS', 'VERIFY_FIX']);
    const activity = await prisma.ticketActivity.findFirst({ where: { ticketId: created.id, toStatus: 'IN_PROGRESS' } });
    expect(activity?.actorUserId).toBe(world.ids.dev);

    const planned = await ticket();
    await request(server).post('/api/projects/web/fleet/jobs').set(auth('dev'))
      .send({ repoId: world.repoId, command: 'PLAN', planFrom: 'docs/spec.md', maxCostUsd: 5, feature: 'plans', ticketRefs: [`WEB-${planned.number}`] })
      .expect(201);
    expect((await prisma.ticket.findUniqueOrThrow({ where: { id: planned.id } })).status).toBe('CREATED');
  });

  it('cancel and requeue answer with the linked tickets (slice 1a minor, C9 slice 2)', async () => {
    const t = await ticket();
    const res = data<{ job: { id: string } }>(await dispatch({ feature: 'cancel-requeue', ticketRefs: [`WEB-${t.number}`] }).expect(201));

    const cancelled = data<{ state: string; tickets: Array<{ ref: string }> | null }>(
      await request(server).post(`/api/projects/web/fleet/jobs/${res.job.id}/cancel`).set(auth('dev')).expect(200),
    );
    expect(cancelled.state).toBe('CANCELLED');
    expect(cancelled.tickets?.map((x) => x.ref)).toEqual([`WEB-${t.number}`]);

    const requeued = data<{ job: { tickets: Array<{ ref: string }> | null } }>(
      await request(server).post(`/api/projects/web/fleet/jobs/${res.job.id}/requeue`).set(auth('dev')).expect(200),
    );
    expect(requeued.job.tickets?.map((x) => x.ref)).toEqual([`WEB-${t.number}`]);
  });
});
