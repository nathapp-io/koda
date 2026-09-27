/**
 * US-003 — the AgentsService create path (POST /api/agents).
 *
 * The request body used to be spread straight into Prisma (M8), so any field the
 * caller sent — `status`, `id`, … — reached the database. The create payload is
 * now an explicit whitelist, and the agent row plus its roles/capabilities are
 * written inside a single txManager.run callback so a failing role/capability
 * write rolls the agent row back.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService, CreateAgentDto } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';

describe('AgentsService create path (US-003)', () => {
  let testingModule: TestingModule;
  let service: AgentsService;

  let agentRepo: {
    create: jest.Mock;
    createRolesAndCapabilities: jest.Mock;
  };

  // Records which txManager.run callback was active while a repository call ran.
  let activeRunId: number | null = null;
  let runCounter = 0;
  let txManager: {
    run: jest.Mock;
    getClient: jest.Mock;
    isInTransaction: jest.Mock;
  };

  const mockAgent = {
    id: 'agent-123',
    name: 'Subrina Coder',
    slug: 'subrina-coder',
    apiKeyHash: 'hashed-key',
    status: 'ACTIVE',
    maxConcurrentTickets: 3,
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
    updatedAt: new Date('2026-09-27T00:00:00.000Z'),
  };

  const authConfig: IAuthConfig = {
    jwtSecret: 'jwt-secret',
    jwtExpiresIn: '15m',
    jwtRefreshSecret: 'jwt-refresh-secret',
    jwtRefreshExpiresIn: '7d',
    apiKeySecret: 'test-secret',
    registrationEnabled: false,
  };

  /** Simulates a request body carrying fields the DTO does not declare. */
  const withClientSuppliedFields = (dto: CreateAgentDto): CreateAgentDto =>
    Object.assign(dto, { status: 'OFFLINE', id: 'x' });

  beforeEach(async () => {
    activeRunId = null;
    runCounter = 0;

    agentRepo = {
      create: jest.fn().mockResolvedValue(mockAgent),
      createRolesAndCapabilities: jest.fn().mockResolvedValue(undefined),
    };

    txManager = {
      run: jest.fn(async (fn: () => Promise<unknown>) => {
        const runId = ++runCounter;
        const previousRunId = activeRunId;
        activeRunId = runId;
        try {
          return await fn();
        } finally {
          activeRunId = previousRunId;
        }
      }),
      getClient: jest.fn(),
      isInTransaction: jest.fn(() => false),
    };

    testingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        { provide: PrismaAgentRepository, useValue: agentRepo },
        { provide: AUTH_CFG, useValue: authConfig },
        { provide: TRANSACTION_MANAGER, useValue: txManager },
        {
          provide: KodaDomainWriter,
          useValue: { writeAgentAction: jest.fn().mockResolvedValue({ canonicalId: 'evt-1' }) },
        },
      ],
    }).compile();

    service = testingModule.get(AgentsService);
  });

  afterEach(async () => {
    await testingModule.close();
    jest.clearAllMocks();
  });

  it('AC1: passes create an object whose keys are exactly name, slug, apiKeyHash and maxConcurrentTickets', async () => {
    await service.generateApiKey(
      withClientSuppliedFields({
        name: 'Subrina Coder',
        slug: 'subrina-coder',
        maxConcurrentTickets: 4,
        roles: ['DEVELOPER'],
        capabilities: ['typescript'],
      }),
    );

    const createArg = agentRepo.create.mock.calls[0][0];
    expect(Object.keys(createArg).sort()).toEqual([
      'apiKeyHash',
      'maxConcurrentTickets',
      'name',
      'slug',
    ]);
  });

  it('AC1 boundary: never forwards the client-supplied status, id, roles or capabilities', async () => {
    await service.generateApiKey(
      withClientSuppliedFields({
        name: 'Subrina Coder',
        slug: 'subrina-coder',
        roles: ['DEVELOPER'],
      }),
    );

    const createArg = agentRepo.create.mock.calls[0][0];
    expect(createArg).not.toHaveProperty('status');
    expect(createArg).not.toHaveProperty('id');
    expect(createArg).not.toHaveProperty('roles');
    expect(createArg).not.toHaveProperty('capabilities');
    expect(createArg.name).toBe('Subrina Coder');
    expect(createArg.slug).toBe('subrina-coder');
    expect(createArg.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('AC1 boundary: still derives the slug from the name when no slug is supplied', async () => {
    await service.generateApiKey({ name: 'Subrina Coder', roles: ['DEVELOPER'] });

    const createArg = agentRepo.create.mock.calls[0][0];
    expect(createArg.slug).toBe('subrina-coder');
  });

  it('AC6: rejects with the createRolesAndCapabilities error and runs both writes in one txManager.run callback', async () => {
    const failure = new Error('agentRoleEntry insert failed');
    const writes: Array<{ op: string; runId: number | null }> = [];

    agentRepo.create.mockImplementation(async () => {
      writes.push({ op: 'create', runId: activeRunId });
      return mockAgent;
    });

    agentRepo.createRolesAndCapabilities.mockImplementation(async () => {
      writes.push({ op: 'createRolesAndCapabilities', runId: activeRunId });
      throw failure;
    });

    await expect(
      service.generateApiKey({
        name: 'Subrina Coder',
        slug: 'subrina-coder',
        roles: ['DEVELOPER'],
      }),
    ).rejects.toBe(failure);

    expect(writes.map((write) => write.op)).toEqual(['create', 'createRolesAndCapabilities']);
    expect(writes[0].runId).not.toBeNull();
    expect(writes[0].runId).toBe(writes[1].runId);
    expect(txManager.run).toHaveBeenCalledTimes(1);
  });

  it('AC6 boundary: a successful create still runs inside exactly one txManager.run callback', async () => {
    const writes: Array<{ op: string; runId: number | null }> = [];

    agentRepo.create.mockImplementation(async () => {
      writes.push({ op: 'create', runId: activeRunId });
      return mockAgent;
    });

    agentRepo.createRolesAndCapabilities.mockImplementation(async () => {
      writes.push({ op: 'createRolesAndCapabilities', runId: activeRunId });
    });

    await service.generateApiKey({
      name: 'Subrina Coder',
      slug: 'subrina-coder',
      roles: ['DEVELOPER'],
    });

    expect(writes.map((write) => write.op)).toEqual(['create', 'createRolesAndCapabilities']);
    expect(writes[0].runId).not.toBeNull();
    expect(writes[0].runId).toBe(writes[1].runId);
    expect(txManager.run).toHaveBeenCalledTimes(1);
  });
});
