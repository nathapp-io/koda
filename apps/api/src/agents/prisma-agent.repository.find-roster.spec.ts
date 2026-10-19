import type { Mock } from 'vitest';
/**
 * US-002 — PrismaAgentRepository.findProjectRoster must read the project's
 * local compatibility membership (not the ticket-derived list) and group open-ticket counts
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
  let rosterFixtures: Mock;
  let agentFindMany: Mock;
  let ticketFindMany: Mock;
  let projectFindUnique: Mock;

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });

    rosterFixtures = vi.fn();
    ticketFindMany = vi.fn();
    projectFindUnique = vi.fn();

    prisma.client.agentProject = { findMany: vi.fn(async () => (await rosterFixtures()).map(
      (row: { createdAt: Date; addedById: string | null; agent: { slug: string } }) => ({
        agentId: row.agent.slug, createdAt: row.createdAt, addedById: row.addedById,
      }),
    )) };
    agentFindMany = vi.fn(async () => (await rosterFixtures()).map(
      (row: { agent: object & { slug: string } }) => ({ id: row.agent.slug, ...row.agent }),
    ));
    prisma.client.agent = { findMany: agentFindMany };
    prisma.client.roleBinding = { findMany: vi.fn().mockResolvedValue([]) };
    prisma.client.user = { findMany: vi.fn().mockResolvedValue([{ id: 'user-admin', name: 'Admin' }]) };
    prisma.client.ticket = { findMany: ticketFindMany };
    prisma.client.project = { findUnique: projectFindUnique };

    testingModule = await Test.createTestingModule({
      providers: [
        PrismaAgentRepository,
        { provide: PrismaService, useValue: prisma },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn((fn: () => Promise<unknown>) => fn()),
            getClient: vi.fn(),
            isInTransaction: vi.fn(() => false),
          },
        },
      ],
    }).compile();

    repository = testingModule.get(PrismaAgentRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('US-002 AC1: returns a roster record per local membership, ordered by agent name', async () => {
    rosterFixtures.mockResolvedValue([
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

    // Agent details, separate from membership provenance, retain name ordering.
    const where = agentFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ id: { in: ['bot'] } });
    expect(agentFindMany.mock.calls[0][0].orderBy).toEqual({ name: 'asc' });
  });

  it('US-002 AC2: surfaces the adding user id and name on each row', async () => {
    rosterFixtures.mockResolvedValue([
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
    rosterFixtures.mockResolvedValue([
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

  it('US-002 AC4: only reads local sources; ticket holders without a roster row are not returned', async () => {
    rosterFixtures.mockResolvedValue([
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
    rosterFixtures.mockResolvedValue([
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
    rosterFixtures.mockResolvedValue([
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
    rosterFixtures.mockResolvedValue([]);

    const records = await repository.findProjectRoster('proj-1');

    expect(records).toEqual([]);
    expect(ticketFindMany).not.toHaveBeenCalled();
    expect(projectFindUnique).not.toHaveBeenCalled();
  });
});
