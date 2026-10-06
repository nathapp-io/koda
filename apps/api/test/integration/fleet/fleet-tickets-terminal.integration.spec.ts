/**
 * Fleet C9 slice 1a — failure comments on linked tickets (PG), spec §3.2.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-tickets-terminal.integration.spec.ts
 */
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp } from '../../helpers/http-app';
import { FleetHttpWorld, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet ticket failure comments (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  let effects: FleetJobTicketEffects;
  let n = 0;

  const linkedJob = async (state: string, extra: Partial<Prisma.FleetJobUncheckedCreateInput> = {}) => {
    n += 1;
    const ticket = await prisma.ticket.create({ data: { projectId: world.projectId, number: n, type: 'TASK', title: `T${n}`, status: 'IN_PROGRESS' } });
    const job = await prisma.fleetJob.create({
      data: {
        projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'RUN', feature: `f${n}`, profiles: [],
        maxCostUsd: new Prisma.Decimal('1'), selectorLabels: [], requestedById: world.ids.dev, state, leaseEpoch: 1, ...extra,
      },
    });
    await prisma.fleetJobTicket.create({ data: { jobId: job.id, ticketId: ticket.id } });
    return { job, ticket };
  };
  const comments = (ticketId: string) => prisma.comment.findMany({ where: { ticketId }, orderBy: { createdAt: 'asc' } });

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

  it('comments once per attempt, again after a requeued attempt fails, and not for COMPLETED', async () => {
    const { job, ticket } = await linkedJob('ESCALATED', { escalationReason: 'quality review missing WALK' });
    await effects.onTerminal([job.id]);
    await effects.onTerminal([job.id]);
    expect((await comments(ticket.id)).map((c) => c.body)).toEqual([
      `Fleet RUN job ${job.id} ended ESCALATED: quality review missing WALK\n/web/fleet/jobs/${job.id}`,
    ]);
    await prisma.fleetJob.update({ where: { id: job.id }, data: { state: 'FAILED', leaseEpoch: 2, stateReason: 'exit 1' } });
    await effects.onTerminal([job.id]);
    expect(await comments(ticket.id)).toHaveLength(2);

    const done = await linkedJob('COMPLETED');
    await effects.onTerminal([done.job.id]);
    expect(await comments(done.ticket.id)).toHaveLength(0);
  });

  it('writes a null-author GENERAL comment, a COMMENT_ADDED event and its outbox row', async () => {
    const { job, ticket } = await linkedJob('CRASHED', { stateReason: 'runner silent' });
    await effects.onTerminal([job.id]);
    const [comment] = await comments(ticket.id);
    expect(comment).toEqual(expect.objectContaining({ type: 'GENERAL', authorUserId: null, authorAgentId: null }));
    const event = await prisma.ticketEvent.findFirstOrThrow({ where: { ticketId: ticket.id, action: 'COMMENT_ADDED' } });
    expect(event).toEqual(expect.objectContaining({ actorId: world.ids.dev, actorType: 'user', source: 'internal' }));
    // The outbox relay is disabled under Jest (NODE_ENV=test, outbox.config), so no live `commented`
    // event is published; assert the outbox row the relay would deliver instead (brief step 10 fallback).
    expect(await prisma.outboxEvent.count({ where: { type: 'ticket_event', eventId: event.id } })).toBe(1);
  });

  it('skips a ticket deleted after linking', async () => {
    const { job, ticket } = await linkedJob('FAILED', { stateReason: 'x' });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { deletedAt: new Date() } });
    await effects.onTerminal([job.id]);
    expect(await comments(ticket.id)).toHaveLength(0);
  });
});
