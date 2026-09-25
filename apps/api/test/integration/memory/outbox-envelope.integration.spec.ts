/**
 * H13: outbox event envelope end-to-end integration test.
 *
 * Verifies the full producer -> outbox -> fan-out consumer path against a real
 * database:
 *
 * 1. A ticket status transition (TicketTransitionsService.start) enqueues a
 *    `ticket_event` whose payload is the FULL event envelope
 *    (`{ id, type, action, timestamp, ticketId, projectId, actorId, actorType, data }`).
 *    Before H13 the transitions service emitted no ticket_event at all, so
 *    memory extraction never ran for status changes.
 *
 * 2. Ticket assignment (TicketsService.assign) enqueues an `assigned`
 *    ticket_event with the same envelope shape.
 *
 * 3. Running the outbox processor dispatches those payloads through the
 *    MemoryOutboxSubscriber and produces real MemoryItem rows
 *    (`status` / `assigned_to` facts). Before H13 the producer payloads were a
 *    partial projection without `action`/`timestamp`, so the subscriber's
 *    extraction switches never matched and zero rows were produced.
 *
 * Run: cd apps/api && DATABASE_URL=file:./koda-test.ephemeral.db bunx jest test/integration/memory/outbox-envelope --forceExit
 *
 * Bootstrapping follows the resetDb()/DATABASE_URL pattern used by the other
 * DB-backed integration suites (see test/integration/vcs/vcs-merged-pr.integration.spec.ts).
 * All repositories, services, and the transaction manager are real; nothing is mocked.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { resetDb } from '../../helpers/reset-db';
import { PrismaOutboxRepository } from '../../../src/outbox/prisma-outbox.repository';
import { OutboxFanOutRegistry } from '../../../src/outbox/outbox-fan-out-registry';
import { OutboxService } from '../../../src/outbox/outbox.service';
import { PrismaEventsRepository } from '../../../src/events/prisma-events.repository';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { PrismaMemoryItemRepository } from '../../../src/memory/prisma-memory-item.repository';
import { ExtractionService } from '../../../src/memory/extraction.service';
import { MemoryOutboxSubscriber } from '../../../src/memory/memory-outbox.subscriber';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { MemoryKind, TicketStatus } from '../../../src/common/enums';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('H13: outbox ticket_event envelope drives memory extraction (real DB)', () => {
  jest.setTimeout(30000);

  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let outboxService: OutboxService;
  let ticketsService: TicketsService;
  let transitionsService: TicketTransitionsService;

  /**
   * Emissions are fire-and-forget (`void` promises), so the outbox row may land
   * a few microtasks after the service call returns. Poll briefly for the row
   * whose payload carries the expected action.
   */
  async function waitForOutboxRow(predicateAction: string, timeoutMs = 5000): Promise<{
    id: string;
    eventId: string;
    payload: string;
  }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma.outboxEvent.findMany({
        where: { eventType: 'ticket_event', status: 'pending' },
      });
      const match = rows.find((r) => {
        try {
          return (JSON.parse(r.payload) as { action?: string }).action === predicateAction;
        } catch {
          return false;
        }
      });
      if (match) return match;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for pending outbox row with action '${predicateAction}'`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  let projectId: string;
  let adminUserId: string;
  let transitionTicketId: string;
  let assignTicketId: string;

  let principal: KodaPrincipal;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    await resetDb(DATABASE_URL);

    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;

    // Pass-through transaction manager: repositories always issue statements on
    // the ambient PrismaService.client, so on SQLite a real interactive
    // transaction would just hold a write lock. A pass-through is behaviorally
    // equivalent here while keeping the FK enforcement of the real database.
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };

    // Real outbox stack + real memory fan-out subscriber.
    const outboxRepo = new PrismaOutboxRepository(txManager, prismaService);
    const fanOutRegistry = new OutboxFanOutRegistry();
    outboxService = new OutboxService(outboxRepo, fanOutRegistry);
    const ticketEventService = new TicketEventService(new PrismaEventsRepository(prismaService));
    const memoryRepository = new PrismaMemoryItemRepository(txManager, prismaService);
    const memorySubscriber = new MemoryOutboxSubscriber(
      fanOutRegistry,
      new ExtractionService(),
      memoryRepository,
    );
    memorySubscriber.onModuleInit();

    // Real producers.
    const ticketRepo = new PrismaTicketsRepository(prismaService);
    ticketsService = new TicketsService(ticketRepo, txManager, ticketEventService, outboxService);
    transitionsService = new TicketTransitionsService(
      ticketRepo,
      txManager,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ticketEventService,
      outboxService,
    );

    // Seed: project, ADMIN user (assignee), and two tickets.
    const project = await prisma.project.create({
      data: { name: 'H13 Project', slug: 'h13-project', key: 'HKK' },
    });
    projectId = project.id;

    const admin = await prisma.user.create({
      data: {
        email: 'h13-admin@koda.test',
        name: 'H13 Admin',
        passwordHash: 'not-a-real-hash',
        role: 'ADMIN',
      },
    });
    adminUserId = admin.id;
    principal = {
      id: admin.id,
      sub: admin.id,
      actorType: 'user',
      role: 'ADMIN',
      email: 'h13-admin@koda.test',
      blacklisted: false,
      revoked: false,
      authorities: [],
      name: 'H13 Admin',
    } as unknown as KodaPrincipal;

    const transitionTicket = await prisma.ticket.create({
      data: {
        projectId,
        number: 1,
        type: 'BUG',
        title: 'Transition me',
        status: TicketStatus.VERIFIED,
        priority: 'HIGH',
      },
    });
    transitionTicketId = transitionTicket.id;

    const assignTicket = await prisma.ticket.create({
      data: {
        projectId,
        number: 2,
        type: 'BUG',
        title: 'Assign me',
        status: TicketStatus.CREATED,
        priority: 'MEDIUM',
      },
    });
    assignTicketId = assignTicket.id;
  });

  afterAll(async () => {
    if (prismaService) {
      await prismaService.onModuleDestroy();
    }
  });

  it('RED baseline: the legacy partial payload shape produces zero memory items', async () => {
    // Before H13 producers enqueued {ticketId, projectId, actorId, data} with no
    // action/id/timestamp. The memory subscriber switches on `action`, so this
    // payload was silently ignored — this test pins that baseline at runtime.
    await outboxService.enqueue({
      projectId,
      eventType: 'ticket_event',
      eventId: 'legacy-evt-1',
      payload: {
        ticketId: transitionTicketId,
        projectId,
        actorId: adminUserId,
        data: {},
      },
    });
    await outboxService.processPending();

    const items = await prisma.memoryItem.findMany({
      where: { projectId, subject: `ticket:${transitionTicketId}` },
    });
    expect(items).toHaveLength(0);

    const processed = await prisma.outboxEvent.findFirstOrThrow({ where: { eventId: 'legacy-evt-1' } });
    expect(processed.status).toBe('completed');
  });

  it('status transition enqueues a status_changed ticket_event whose full envelope yields a status MemoryItem', async () => {
    // Sanity: no memory items for the ticket before the transition.
    const before = await prisma.memoryItem.count({ where: { projectId, subject: `ticket:${transitionTicketId}` } });
    expect(before).toBe(0);

    // RED (pre-H13): transitions emitted no ticket_event at all, so this
    // enqueued nothing and the outbox had nothing to process.
    await transitionsService.start('h13-project', 'HKK-1', principal);

    // The outbox payload must be the full event envelope.
    const outboxRow = await waitForOutboxRow('status_changed');
    const payload = JSON.parse(outboxRow.payload);
    expect(payload).toEqual({
      id: expect.any(String),
      type: 'ticket_event',
      action: 'status_changed',
      timestamp: expect.any(String),
      ticketId: transitionTicketId,
      projectId,
      actorId: adminUserId,
      actorType: 'user',
      data: { fromStatus: TicketStatus.VERIFIED, newStatus: TicketStatus.IN_PROGRESS },
    });
    expect(payload.id).toBe(outboxRow.eventId);
    expect(() => new Date(payload.timestamp)).not.toThrow();

    // GREEN: the full envelope drives real memory extraction end-to-end.
    await outboxService.processPending();

    const items = await prisma.memoryItem.findMany({
      where: { projectId, subject: `ticket:${transitionTicketId}` },
    });
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.kind).toBe(MemoryKind.FACT);
    expect(item.predicate).toBe('status');
    expect(item.object).toBe(TicketStatus.IN_PROGRESS);
    expect(item.sourceType).toBe('ticket_event');
    expect(item.status).toBe('active');

    // The outbox row was processed successfully.
    const processed = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: outboxRow.id } });
    expect(processed.status).toBe('completed');
  });

  it('assign enqueues an assigned ticket_event whose full envelope yields an assigned_to MemoryItem', async () => {
    await ticketsService.assign('h13-project', 'HKK-2', { userId: adminUserId }, principal);

    const outboxRow = await waitForOutboxRow('assigned');
    const payload = JSON.parse(outboxRow.payload);
    expect(payload).toEqual({
      id: expect.any(String),
      type: 'ticket_event',
      action: 'assigned',
      timestamp: expect.any(String),
      ticketId: assignTicketId,
      projectId,
      actorId: adminUserId,
      actorType: 'user',
      data: { assignedTo: adminUserId },
    });

    await outboxService.processPending();

    const items = await prisma.memoryItem.findMany({
      where: { projectId, subject: `ticket:${assignTicketId}`, predicate: 'assigned_to' },
    });
    expect(items).toHaveLength(1);
    expect(items[0].object).toBe(adminUserId);
    expect(items[0].kind).toBe(MemoryKind.FACT);
    expect(items[0].sourceType).toBe('ticket_event');
  });
});
