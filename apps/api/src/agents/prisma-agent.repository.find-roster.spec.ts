/**
 * US-002 — PrismaAgentRepository.findProjectRoster must read the project's
 * AgentProject table (not the ticket-derived list) and group open-ticket counts
 * and refs into each roster row, capped at 10 refs and ordered by ticket
 * `createdAt` ascending. The integration test
 * `test/integration/agents/agent-roster-repository.integration.spec.ts` covers
 * the real Postgres form; this file pins the query shape on the repository
 * boundary so a future refactor of `findProjectRoster` cannot drop the cap,
 * the ordering, or the `assignedToAgent.slug` filter.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { PrismaAgentRepository } from './prisma-agent.repository';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository.findProjectRoster (US-002)', () => {
  let testingModule: TestingModule;
  let repository: PrismaAgentRepository;
  let prisma: MockPrismaService;
  let agentProjectFindMany: jest.Mock;
  let ticketFindMany: jest.Mock;
  let projectFindUnique: jest.Mock;

  beforeEach(async () => {
    prisma = createMockPrismaService();

    agentProjectFindMany = jest.fn();
    ticketFindMany = jest.fn();
    projectFindUnique = jest.fn();

    prisma.client.agentProject = { findMany: agentProjectFindMany };
    prisma.client.ticket = { findMany: ticketFindMany };
    prisma.client.project = { findUnique: projectFindUnique };

    testingModule = await Test.createTestingModule({
      providers: [
        PrismaAgentRepository,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
          },
        },
      ],
    }).compile();

    repository = testingModule.get(PrismaAgentRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    jest.clearAllMocks();
  });

  it('US-002 AC1: returns a roster record per AgentProject row, ordered by agent name', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: 'user-admin',
        addedBy: { id: 'user-admin', name: 'Admin' },
        agent: {
          slug: 'bot',
          name: 'Bot',
          status: 'ACTIVE',
          roles: [{ role: 'DEVELOPER' }],
          capabilities: [{ capability: 'typescript' }],
        },
      },
    ]);
    ticketFindMany.mockResolvedValue([]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });

    const records = await repository.findProjectRoster('proj-1');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      slug: 'bot',
      name: 'Bot',
      status: 'ACTIVE',
      roles: ['DEVELOPER'],
      capabilities: ['typescript'],
      openTicketCount: 0,
      openTicketRefs: [],
      addedById: 'user-admin',
      addedByName: 'Admin',
    });

    // Ordered by agent name ascending (Prisma: `agent: { name: 'asc' }`)
    const where = agentProjectFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ projectId: 'proj-1' });
    expect(agentProjectFindMany.mock.calls[0][0].orderBy).toEqual({ agent: { name: 'asc' } });
  });

  it('US-002 AC2: surfaces the adding user id and name on each row', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: 'user-admin',
        addedBy: { id: 'user-admin', name: 'Admin' },
        agent: {
          slug: 'bot',
          name: 'Bot',
          status: 'ACTIVE',
          roles: [],
          capabilities: [],
        },
      },
    ]);
    ticketFindMany.mockResolvedValue([]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });

    const records = await repository.findProjectRoster('proj-1');

    expect(records[0].addedById).toBe('user-admin');
    expect(records[0].addedByName).toBe('Admin');
  });

  it('US-002 AC3: returns null addedById / addedByName for backfilled rows', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: null,
        addedBy: null,
        agent: {
          slug: 'bot',
          name: 'Bot',
          status: 'ACTIVE',
          roles: [],
          capabilities: [],
        },
      },
    ]);
    ticketFindMany.mockResolvedValue([]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });

    const records = await repository.findProjectRoster('proj-1');

    expect(records[0].addedById).toBeNull();
    expect(records[0].addedByName).toBeNull();
  });

  it('US-002 AC4: only reads AgentProject rows; ticket holders without a roster row are not returned', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: 'user-admin',
        addedBy: { id: 'user-admin', name: 'Admin' },
        agent: {
          slug: 'rostered-bot',
          name: 'Rostered Bot',
          status: 'ACTIVE',
          roles: [],
          capabilities: [],
        },
      },
    ]);
    ticketFindMany.mockResolvedValue([]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });

    const records = await repository.findProjectRoster('proj-1');

    expect(records.map((r) => r.slug)).toEqual(['rostered-bot']);
  });

  it('US-002 AC5: open ticket count excludes CLOSED, REJECTED, and soft-deleted tickets', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: null,
        addedBy: null,
        agent: {
          slug: 'bot',
          name: 'Bot',
          status: 'ACTIVE',
          roles: [],
          capabilities: [],
        },
      },
    ]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });
    ticketFindMany.mockResolvedValue([
      { number: 1, createdAt: new Date('2026-09-01'), assignedToAgent: { slug: 'bot' } },
      { number: 2, createdAt: new Date('2026-09-02'), assignedToAgent: { slug: 'bot' } },
    ]);

    const records = await repository.findProjectRoster('proj-1');

    const where = ticketFindMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ notIn: ['CLOSED', 'REJECTED'] });
    expect(where.deletedAt).toBeNull();
    expect(where.projectId).toBe('proj-1');
    expect(where.assignedToAgent).toEqual({ slug: { in: ['bot'] } });
    expect(records[0].openTicketCount).toBe(2);
    expect(records[0].openTicketRefs).toEqual(['ALP-1', 'ALP-2']);
    expect(ticketFindMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });

  it('US-002 AC6: caps the open-ticket ref list at 10 but keeps the total count', async () => {
    agentProjectFindMany.mockResolvedValue([
      {
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        addedById: null,
        addedBy: null,
        agent: {
          slug: 'bot',
          name: 'Bot',
          status: 'ACTIVE',
          roles: [],
          capabilities: [],
        },
      },
    ]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });
    ticketFindMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        number: i + 1,
        createdAt: new Date(`2026-09-${String(i + 1).padStart(2, '0')}`),
        assignedToAgent: { slug: 'bot' },
      })),
    );

    const records = await repository.findProjectRoster('proj-1');

    expect(records[0].openTicketCount).toBe(12);
    expect(records[0].openTicketRefs).toHaveLength(10);
  });

  it('US-002 boundary: returns an empty array when the project has no roster', async () => {
    agentProjectFindMany.mockResolvedValue([]);

    const records = await repository.findProjectRoster('proj-1');

    expect(records).toEqual([]);
    expect(ticketFindMany).not.toHaveBeenCalled();
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
