import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { FanOutPublisher } from '../../../src/outbox/fan-out-publisher';
import { PrismaOutboxRepository } from '../../../src/outbox/prisma-outbox.repository';
import { EntityGraphOutboxSubscriber } from '../../../src/entity-graph/entity-graph-outbox.subscriber';
import { EntityGraphService } from '../../../src/entity-graph/entity-graph.service';
import { InMemoryEntityStore } from '../../../src/entity-graph/in-memory-entity-store';
import { EntityLinkRelation } from '../../../src/entity-graph/dto/entity-graph.types';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { PrismaEventsRepository } from '../../../src/events/prisma-events.repository';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { AfterCommitService } from '../../../src/permissions/after-commit.service';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';

const describeDb = canRunDbTests() ? describe : describe.skip;
const prisma = createTestPrismaClient();

describeDb('TicketsService assignment to entity graph owner link (DB contract)', () => {
  vi.setConfig({ testTimeout: 30_000 });
  const prismaService = { client: prisma } as unknown as PrismaService<PrismaClient>;
  const txManager: ITransactionManager = {
    run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
    getClient: <C = unknown>(): C => prisma as unknown as C,
    isInTransaction: () => false,
  };
  let projectId: string;
  let projectSlug: string;
  let callerId: string;
  let principal: { id: string; sub: string; actorType: 'user'; role: string; email: string; name: string; blacklisted: boolean; revoked: boolean; authorities: never[] };
  let tickets: TicketsService;
  let fanOut: FanOutPublisher;
  let graphStore: InMemoryEntityStore;

  beforeAll(async () => {
    await resetDb();
    const project = await prisma.project.create({ data: { name: 'Owner-link contract', slug: 'owner-link-contract', key: 'OLC' } });
    projectId = project.id;
    projectSlug = project.slug;
    const caller = await prisma.user.create({ data: { email: 'owner-link-caller@koda.test', name: 'Caller', passwordHash: 'x' } });
    callerId = caller.id;
    await grantBaseline(prisma, { type: 'USER', id: callerId });
    principal = { id: callerId, sub: callerId, actorType: 'user', role: 'USER', email: caller.email, name: caller.name, blacklisted: false, revoked: false, authorities: [] };

    const outbox = { record: vi.fn(async ({ type, payload, metadata }: { type: string; payload: unknown; metadata: { projectId: string; eventId: string } }) => {
      await prisma.outboxEvent.create({ data: { type, eventId: metadata.eventId, projectId: metadata.projectId, payload: JSON.stringify(payload), status: 'pending' } });
    }) } as unknown as OutboxService;
    const ticketRepo = new PrismaTicketsRepository(prismaService);
    const eventService = new TicketEventService(new PrismaEventsRepository(prismaService));
    const transitions = new TicketTransitionsService(ticketRepo, txManager,
      { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }) } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never, new AfterCommitService(),
      undefined, undefined, undefined, undefined, undefined, undefined, eventService, outbox);
    tickets = new TicketsService(ticketRepo, txManager, eventService, outbox, transitions,
      { can: vi.fn().mockResolvedValue({ allowed: true, reason: 'granted' }), effectiveKeys: vi.fn().mockResolvedValue(new Set(['project.read'])) } as never,
      { record: vi.fn().mockResolvedValue(undefined) } as never);

    graphStore = new InMemoryEntityStore();
    fanOut = new FanOutPublisher({ recordLastError: vi.fn().mockResolvedValue(undefined) } as never);
    new EntityGraphOutboxSubscriber(fanOut, new EntityGraphService(graphStore)).onModuleInit();
  });

  afterAll(async () => { await prisma.$disconnect(); });

  async function assignAndAssertOwner(kind: 'user' | 'agent'): Promise<void> {
    const number = kind === 'user' ? 1 : 2;
    const ticket = await prisma.ticket.create({ data: { projectId, number, type: 'BUG', title: `${kind} assignment`, status: 'CREATED', priority: 'MEDIUM' } });
    let ownerId: string;
    if (kind === 'user') {
      const owner = await prisma.user.create({ data: { email: 'owner-link-assignee@koda.test', name: 'Assignee', passwordHash: 'x' } });
      ownerId = owner.id;
      await grantBaseline(prisma, { type: 'USER', id: ownerId });
      await tickets.assign(projectSlug, `OLC-${number}`, { userId: ownerId }, principal as never);
    } else {
      const owner = await prisma.agent.create({ data: { name: 'Owner agent', slug: 'owner-link-agent', apiKeyHash: 'owner-link-agent-hash', status: 'ACTIVE' } });
      ownerId = owner.id;
      const viewer = await prisma.role.findUniqueOrThrow({ where: { key: 'viewer' } });
      await prisma.roleBinding.create({ data: { projectId, principalType: 'AGENT', principalId: ownerId, roleId: viewer.id, grantedByType: 'USER', grantedById: callerId } });
      await tickets.assign(projectSlug, `OLC-${number}`, { agentId: ownerId }, principal as never);
    }

    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'ticket_event', projectId, payload: { contains: '"ticketId":"' + ticket.id + '"' } }, orderBy: { createdAt: 'desc' } });
    const payload: unknown = JSON.parse(row.payload);
    await fanOut.publish({ id: row.id, type: row.type, eventId: row.eventId, payload, status: 'pending', createdAt: row.createdAt, projectId: row.projectId } as never);
    const links = await graphStore.findLinksBySource(projectId, ticket.id);
    expect(links).toContainEqual(expect.objectContaining({ targetId: `owner:${ownerId}`, relation: EntityLinkRelation.TICKET_TO_OWNER }));
  }

  it('AC-8: a real user assignment outbox payload creates the user owner link', async () => { await assignAndAssertOwner('user'); });
  it('AC-9: a real agent assignment outbox payload creates the agent owner link', async () => { await assignAndAssertOwner('agent'); });
});
