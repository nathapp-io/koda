import type { Mock } from 'vitest';
/**
 * S4c US-003 — PrismaAgentRepository's roster-write surface: the insert that
 * must report a duplicate instead of throwing, the open-ticket read that feeds
 * the removal conflict, the roster delete, and the per-project advisory lock
 * the removal shares with ticket assignment (US-004). The Postgres form of the
 * duplicate path is covered by the acceptance run; this pins the query shape.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { KODA_LOCK_CLASS } from '../common/utils/advisory-lock';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository roster writes (S4c US-003)', () => {
  let testingModule: TestingModule;
  let repository: PrismaAgentRepository;
  let prisma: MockPrismaService;
  let agentProjectCreateMany: Mock;
  let agentProjectDeleteMany: Mock;
  let agentProjectFindUnique: Mock;
  let ticketCount: Mock;
  let ticketFindMany: Mock;
  let projectFindUnique: Mock;
  let queryRaw: Mock;

  beforeEach(async () => {
    prisma = createMockPrismaService({ fn: vi.fn });

    agentProjectCreateMany = vi.fn();
    agentProjectDeleteMany = vi.fn();
    agentProjectFindUnique = vi.fn();
    ticketCount = vi.fn();
    ticketFindMany = vi.fn();
    projectFindUnique = vi.fn();
    queryRaw = prisma.client.$queryRaw as Mock;

    prisma.client.agentProject = {
      createMany: agentProjectCreateMany,
      deleteMany: agentProjectDeleteMany,
      findUnique: agentProjectFindUnique,
    };
    prisma.client.ticket = { count: ticketCount, findMany: ticketFindMany };
    prisma.client.project = { findUnique: projectFindUnique };

    testingModule = await Test.createTestingModule({
      providers: [PrismaAgentRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = testingModule.get(PrismaAgentRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('addToProjectRoster inserts the roster row with the adding user and reports created', async () => {
    agentProjectCreateMany.mockResolvedValue({ count: 1 });

    const outcome = await repository.addToProjectRoster('agent-1', 'proj-1', 'user-admin');

    expect(outcome).toBe('created');
    expect(agentProjectCreateMany).toHaveBeenCalledWith({
      data: [{ agentId: 'agent-1', projectId: 'proj-1', addedById: 'user-admin' }],
      skipDuplicates: true,
    });
  });

  it('addToProjectRoster reports alreadyAssigned when the composite key skips the row', async () => {
    agentProjectCreateMany.mockResolvedValue({ count: 0 });

    await expect(repository.addToProjectRoster('agent-1', 'proj-1', 'user-admin')).resolves.toBe('alreadyAssigned');
  });

  it('countOpenProjectTickets counts the open tickets and refs the 10 oldest as <key>-<number>', async () => {
    ticketCount.mockResolvedValue(12);
    ticketFindMany.mockResolvedValue([{ number: 3 }, { number: 4 }]);
    projectFindUnique.mockResolvedValue({ key: 'ALP' });

    const result = await repository.countOpenProjectTickets('agent-1', 'proj-1');

    expect(result).toEqual({ count: 12, refs: ['ALP-3', 'ALP-4'] });
    const where = ticketCount.mock.calls[0][0].where;
    expect(where).toEqual({
      projectId: 'proj-1',
      assignedToAgentId: 'agent-1',
      status: { notIn: ['CLOSED', 'REJECTED'] },
      deletedAt: null,
    });
    expect(ticketFindMany.mock.calls[0][0]).toMatchObject({
      where,
      select: { number: true },
      take: 10,
    });
    expect(ticketFindMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'asc' }, { number: 'asc' }]);
  });

  it('removeFromProjectRoster deletes the roster row by agent and project', async () => {
    await repository.removeFromProjectRoster('agent-1', 'proj-1');

    expect(agentProjectDeleteMany).toHaveBeenCalledWith({ where: { agentId: 'agent-1', projectId: 'proj-1' } });
  });

  it('lockProjectAgents takes the PROJECT_AGENTS advisory lock for the project', async () => {
    await repository.lockProjectAgents('proj-1');

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([KODA_LOCK_CLASS.PROJECT_AGENTS, 'proj-1']);
  });
});
