import type { Mock } from 'vitest';
/**
 * PrismaAgentRepository's PROJECT_AGENTS advisory lock, the one ticket assignment takes before
 * reading the roster.
 *
 * S4c US-003 pinned the roster writes here too (the insert that reports a duplicate, the roster
 * delete). Permissions P1 US-003 deleted those methods with the two roster routes, so the lock is
 * what remains: an agent leaves a project by deleting a binding, and `MembershipService.removeBinding`
 * takes the same lock.
 *
 * The open-ticket read the writes used to pin lives in
 * `permissions/open-agent-tickets.queries.spec.ts` (Permissions P1 US-002).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService, createMockPrismaService } from '@nathapp/nestjs-prisma';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { KODA_LOCK_CLASS } from '../common/utils/advisory-lock';

type MockPrismaService = ReturnType<typeof createMockPrismaService>;

describe('PrismaAgentRepository project agent lock (S4c US-003)', () => {
  let testingModule: TestingModule;
  let repository: PrismaAgentRepository;
  let queryRaw: Mock;

  beforeEach(async () => {
    const prisma: MockPrismaService = createMockPrismaService({ fn: vi.fn });
    queryRaw = prisma.client.$queryRaw as Mock;

    testingModule = await Test.createTestingModule({
      providers: [PrismaAgentRepository, { provide: PrismaService, useValue: prisma }],
    }).compile();

    repository = testingModule.get(PrismaAgentRepository);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('lockProjectAgents takes the PROJECT_AGENTS advisory lock for the project', async () => {
    await repository.lockProjectAgents('proj-1');

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock');
    expect(values).toEqual([KODA_LOCK_CLASS.PROJECT_AGENTS, 'proj-1']);
  });
});
