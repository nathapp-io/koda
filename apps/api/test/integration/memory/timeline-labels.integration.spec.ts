import { randomUUID } from 'node:crypto';
import { canRunDbTests } from '../../helpers/test-environment';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaTimelineRepository } from '../../../src/memory/prisma-timeline.repository';
import { TimelineService } from '../../../src/memory/timeline.service';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('timeline readable labels (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let service: TimelineService;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { adapter: createPgAdapter(DATABASE_URL) } });
    await prisma.onModuleInit();
    service = new TimelineService(new PrismaTimelineRepository(prisma));
    const project = await prisma.client.project.create({
      data: { name: 'Timeline labels', slug: `timeline-labels-${randomUUID()}`, key: `TL${randomUUID().slice(0, 6)}` },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
  });

  it('AC-7: resolves a ticket event actor, project ref and title', async () => {
    const user = await prisma.client.user.create({ data: { email: `${randomUUID()}@koda.test`, name: 'Alice', passwordHash: 'x' } });
    const ticket = await prisma.client.ticket.create({
      data: { projectId, number: 1, type: 'TASK', title: 'Fix timeline labels', createdByUserId: user.id },
    });
    await prisma.client.ticketEvent.create({
      data: { projectId, ticketId: ticket.id, action: 'TICKET_CREATED', actorId: user.id, actorType: 'user', source: 'api' },
    });

    const result = await service.getProjectTimeline({ projectId, eventTypes: ['ticket_event'] });

    expect(result.events).toContainEqual(expect.objectContaining({
      ticketId: ticket.id,
      actorName: 'Alice',
      ticketRef: `${(await prisma.client.project.findUniqueOrThrow({ where: { id: projectId } })).key}-${ticket.number}`,
      ticketTitle: ticket.title,
    }));
  });

  it('AC-8: returns a null actor name when the ticket event actor has no principal row', async () => {
    const unknownActor = `gone-${randomUUID()}`;
    await prisma.client.ticketEvent.create({
      data: { projectId, action: 'TICKET_UPDATED', actorId: unknownActor, actorType: 'user', source: 'api' },
    });

    const result = await service.getProjectTimeline({ projectId, eventTypes: ['ticket_event'] });

    expect(result.events).toContainEqual(expect.objectContaining({ actorId: unknownActor, actorName: null }));
  });

  it('AC-9: retains the name of a soft-deleted agent event actor', async () => {
    const slug = `retired-${randomUUID()}`;
    const agent = await prisma.client.agent.create({
      data: { name: 'retired-bot', slug, apiKeyHash: randomUUID(), deletedAt: new Date() },
    });
    await prisma.client.agentEvent.create({
      data: { projectId, agentId: agent.id, actorId: agent.id, action: 'AGENT_EVENT', source: 'api' },
    });

    const result = await service.getProjectTimeline({ projectId, eventTypes: ['agent_event'] });

    expect(result.events).toContainEqual(expect.objectContaining({ actorId: agent.id, actorName: 'retired-bot' }));
  });
});
