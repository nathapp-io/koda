/**
 * Producers record outbox rows atomically with their business writes (Track 1 slice 2).
 * Run: cd apps/api && bun run test:db:up && bun run test:integration -- producer-atomicity
 */
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { outboxConfig } from '../../../src/config/outbox.config';
import { OutboxModule } from '../../../src/outbox/outbox.module';
import { PrismaOutboxStore } from '../../../src/outbox/prisma-outbox.store';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { PrismaEventsRepository } from '../../../src/events/prisma-events.repository';
import { WebhookDispatcherService } from '../../../src/webhook/webhook-dispatcher.service';
import { PrismaWebhookRepository } from '../../../src/webhook/prisma-webhook.repository';
import { TicketStatus, TicketType } from '../../../src/common/enums';
import { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;
const DATABASE_URL = process.env.DATABASE_URL;

describeIntegration('producers record outbox rows atomically', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let tickets: TicketsService;
  let transitions: TicketTransitionsService;
  let store: PrismaOutboxStore;
  let principal: KodaPrincipal;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [outboxConfig] }),
        PrismaModule.forRoot({ client: PrismaClient, transaction: true, clientOptions: { datasources: { db: { url: DATABASE_URL } } } }),
        OutboxModule,
      ],
      providers: [
        TicketsService,
        TicketTransitionsService,
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
        TicketEventService,
        PrismaEventsRepository,
        WebhookDispatcherService,
        PrismaWebhookRepository,
      ],
    }).compile();
    prisma = module.get(PrismaService);
    await prisma.onModuleInit();
    tickets = module.get(TicketsService);
    transitions = module.get(TicketTransitionsService);
    store = module.get(PrismaOutboxStore);

    const project = await prisma.client.project.create({ data: { name: 'Atomic', slug: 'atomic', key: 'ATM' } });
    projectId = project.id;
    const user = await prisma.client.user.create({
      data: { email: 'atomic@koda.test', name: 'Atomic', passwordHash: 'x', role: 'ADMIN' },
    });
    // actorType is the discriminator actorForeignKeys uses; without it the
    // creator lands in createdByAgentId and violates the Agent FK (principal
    // shape copied from ticket-transition-race.integration.spec.ts).
    principal = {
      id: user.id,
      sub: user.id,
      actorType: 'user' as const,
      role: 'ADMIN' as const,
      email: 'atomic@koda.test',
      blacklisted: false,
      revoked: false,
      authorities: [] as string[],
      name: 'Atomic',
    } as unknown as KodaPrincipal;
    await prisma.client.webhook.create({
      data: { projectId, url: 'https://example.test/hook', secret: 's', events: '["STATUS_CHANGE"]' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
    await module?.close();
  });

  it('ticket create commits the ticket, its TicketEvent and exactly one ticket_event row', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'One' }, principal);

    const rows = await prisma.client.outboxEvent.findMany({ where: { type: 'ticket_event' } });
    const events = await prisma.client.ticketEvent.findMany({ where: { ticketId: created.id } });
    expect(events).toHaveLength(1);
    expect(rows.filter((r) => r.eventId === events[0].id)).toHaveLength(1);
    expect(rows[0].projectId).toBe(projectId);
  });

  it('ticket create rolls back the ticket and its TicketEvent when the outbox write fails', async () => {
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('outbox down'));
    const ticketsBefore = await prisma.client.ticket.count();
    const eventsBefore = await prisma.client.ticketEvent.count();

    await expect(tickets.create('atomic', { type: TicketType.BUG, title: 'Two' }, principal)).rejects.toThrow('outbox down');

    expect(await prisma.client.ticket.count()).toBe(ticketsBefore);
    expect(await prisma.client.ticketEvent.count()).toBe(eventsBefore);
  });

  it('a transition records its status_changed event and webhook row in the same commit', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'Three' }, principal);
    await prisma.client.ticket.update({ where: { id: created.id }, data: { status: TicketStatus.VERIFIED } });
    await prisma.client.outboxEvent.deleteMany({});

    await transitions.start('atomic', created.id, principal);

    const rows = await prisma.client.outboxEvent.findMany({});
    expect(rows.map((r) => r.type).sort()).toEqual(['ticket_event', 'webhook_delivery']);
  });

  it('a transition that fails to record rolls back the status change and writes no rows', async () => {
    const created = await tickets.create('atomic', { type: TicketType.BUG, title: 'Four' }, principal);
    await prisma.client.ticket.update({ where: { id: created.id }, data: { status: TicketStatus.VERIFIED } });
    await prisma.client.outboxEvent.deleteMany({});
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('outbox down'));

    await expect(transitions.start('atomic', created.id, principal)).rejects.toThrow('outbox down');

    const ticket = await prisma.client.ticket.findUniqueOrThrow({ where: { id: created.id } });
    expect(ticket.status).toBe(TicketStatus.VERIFIED);
    expect(await prisma.client.outboxEvent.count()).toBe(0);
  });
});
