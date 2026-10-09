/**
 * US-002 (D530) — PrismaAgentRepository.findProjectRoster against a real
 * Postgres. The repository tests pin the query shape on a mock; this file
 * proves the data path holds end-to-end: the AgentProject table is the source
 * of truth, open-ticket counts and refs come from the ticket table filtered by
 * status, soft-deletion excludes rows, and the ref list is capped at 10.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/agents/agent-project-roster.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaAgentRepository.findProjectRoster (PG)', () => {
  const prisma = createTestPrismaClient();
  const repository = new PrismaAgentRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);

  let projectId: string;
  let projectKey: string;
  let rosterAgentId: string;
  let unrosteredAgentId: string;

  beforeAll(async () => {
    await resetDb();

    const project = await prisma.project.create({
      data: { name: 'Roster Project', slug: 'roster-proj', key: 'RPJ' },
    });
    projectId = project.id;
    projectKey = project.key;

    const rosterAgent = await prisma.agent.create({
      data: { name: 'Roster Agent', slug: 'roster-agent', apiKeyHash: 'roster-agent-hash' },
    });
    rosterAgentId = rosterAgent.id;

    const unrosteredAgent = await prisma.agent.create({
      data: { name: 'Unrostered Agent', slug: 'unrostered-agent', apiKeyHash: 'unrostered-agent-hash' },
    });
    unrosteredAgentId = unrosteredAgent.id;

    // Roles/capabilities for the rostered agent — used to verify they ride
    // through to the DTO.
    await prisma.agentRoleEntry.create({ data: { agentId: rosterAgentId, role: 'DEVELOPER' } });
    await prisma.agentCapabilityEntry.create({ data: { agentId: rosterAgentId, capability: 'typescript' } });

    // Roster row added by a user (addedById != null).
    const adder = await prisma.user.create({
      data: { email: 'adder@koda.test', name: 'Adder', passwordHash: 'x' },
    });
    await prisma.agentProject.create({
      data: { projectId, agentId: rosterAgentId, addedById: adder.id },
    });

    // Build 12 open tickets (CREATED) for the rostered agent + 1 CLOSED + 1
    // REJECTED + 1 soft-deleted CREATED. Of the 12, only the first 10 surface as
    // refs (oldest first by createdAt).
    const now = Date.now();
    const openTickets: Array<{ number: number; createdAt: Date; status: string }> = [];
    for (let i = 0; i < 12; i += 1) {
      openTickets.push({ number: i + 1, createdAt: new Date(now - (12 - i) * 1000), status: 'CREATED' });
    }
    await prisma.ticket.createMany({
      data: openTickets.map((t) => ({
        projectId,
        number: t.number,
        type: 'BUG',
        title: `Roster ticket ${t.number}`,
        status: t.status,
        createdByUserId: adder.id,
        assignedToAgentId: rosterAgentId,
        createdAt: t.createdAt,
      })),
    });
    await prisma.ticket.create({
      data: {
        projectId,
        number: 13,
        type: 'BUG',
        title: 'closed',
        status: 'CLOSED',
        createdByUserId: adder.id,
        assignedToAgentId: rosterAgentId,
      },
    });
    await prisma.ticket.create({
      data: {
        projectId,
        number: 14,
        type: 'BUG',
        title: 'rejected',
        status: 'REJECTED',
        createdByUserId: adder.id,
        assignedToAgentId: rosterAgentId,
      },
    });
    await prisma.ticket.create({
      data: {
        projectId,
        number: 15,
        type: 'BUG',
        title: 'soft-deleted',
        status: 'CREATED',
        createdByUserId: adder.id,
        assignedToAgentId: rosterAgentId,
        deletedAt: new Date(),
      },
    });

    // An unrostered agent assigned tickets in the project — they must NOT
    // appear in the roster (AC4).
    await prisma.ticket.create({
      data: {
        projectId,
        number: 16,
        type: 'BUG',
        title: 'unrostered assignment',
        status: 'CREATED',
        createdByUserId: adder.id,
        assignedToAgentId: unrosteredAgentId,
      },
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('AC1+AC2: returns a roster row with slug, name, status, roles, capabilities, addedBy', async () => {
    const records = await repository.findProjectRoster(projectId);

    expect(records).toHaveLength(1);
    const row = records[0];
    expect(row).toMatchObject({
      slug: 'roster-agent',
      name: 'Roster Agent',
      status: 'ACTIVE',
      roles: ['DEVELOPER'],
      capabilities: ['typescript'],
    });
    expect(row.addedById).toBeTruthy();
    expect(row.addedByName).toBe('Adder');
  });

  it('AC4: excludes ticket holders without a roster row', async () => {
    const records = await repository.findProjectRoster(projectId);
    expect(records.map((r) => r.slug)).not.toContain('unrostered-agent');
  });

  it('AC5: counts open tickets (status NOT IN CLOSED/REJECTED, deletedAt null) and lists refs oldest first', async () => {
    const records = await repository.findProjectRoster(projectId);
    const row = records[0];

    // 12 CREATED + 1 soft-deleted CREATED = 12 open (soft-deleted is excluded).
    expect(row.openTicketCount).toBe(12);
    expect(row.openTicketRefs).toEqual([
      'RPJ-1', 'RPJ-2', 'RPJ-3', 'RPJ-4', 'RPJ-5', 'RPJ-6', 'RPJ-7', 'RPJ-8', 'RPJ-9', 'RPJ-10',
    ]);
  });

  it('AC6 boundary: returns an empty array for a project with no roster', async () => {
    const otherProject = await prisma.project.create({
      data: { name: 'Empty', slug: 'roster-empty', key: 'EMP' },
    });
    await expect(repository.findProjectRoster(otherProject.id)).resolves.toEqual([]);
  });
});
