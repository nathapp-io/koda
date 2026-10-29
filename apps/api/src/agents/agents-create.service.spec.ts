import { AuditRecorder } from '../audit/audit-recorder.service';
import { mockAuditRecorder } from '../common/test-helpers/global-stubs.module';
import type { Mock } from 'vitest';
/**
 * US-003 — the AgentsService create path (POST /api/agents).
 *
 * The request body used to be spread straight into Prisma (M8), so any field the
 * caller sent — `status`, `id`, … — reached the database. The create payload is
 * now an explicit whitelist, and the agent row plus its capabilities are written
 * inside a single txManager.run callback so a failing capability write rolls the
 * agent row back.
 *
 * Permissions P1l (US-005): the create writes no `AgentRoleEntry` — a legacy `roles` field in the
 * body reaches nothing — so the transaction has one write to roll back, not two.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG, IAuthConfig } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
import { KodaDomainWriter } from '../koda-domain-writer/koda-domain-writer.service';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AfterCommitService } from '../permissions/after-commit.service';

describe('AgentsService create path (US-003)', () => {
  let testingModule: TestingModule;
  let service: AgentsService;

  let agentRepo: {
    create: Mock;
    createCapabilities: Mock;
  };

  /** Permissions P1a (US-004): the create path binds the new agent to the baseline. */
  let membership: { bindBaseline: Mock; afterCommit: Mock };

  /** Permissions P1 (US-009): the service's required fifth dependency. */
  const permissions = {
    can: vi.fn(async () => ({ allowed: true, reason: 'granted' })),
    effectiveKeys: vi.fn(async () => new Set<string>()),
  };

  // Records which txManager.run callback was active while a repository call ran.
  let activeRunId: number | null = null;
  let runCounter = 0;
  let txManager: {
    run: Mock;
    getClient: Mock;
    isInTransaction: Mock;
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
      create: vi.fn().mockResolvedValue(mockAgent),
      createCapabilities: vi.fn().mockResolvedValue(undefined),
    };

    membership = {
      bindBaseline: vi.fn().mockResolvedValue(undefined),
      // B3: the baseline write joins the create transaction; the stub resolves the callback and has
      // nothing of its own to invalidate.
      afterCommit: vi.fn((fn: () => Promise<unknown>) => fn()),
    };

    txManager = {
      run: vi.fn(async (fn: () => Promise<unknown>) => {
        const runId = ++runCounter;
        const previousRunId = activeRunId;
        activeRunId = runId;
        try {
          return await fn();
        } finally {
          activeRunId = previousRunId;
        }
      }),
      getClient: vi.fn(),
      isInTransaction: vi.fn(() => false),
    };

    testingModule = await Test.createTestingModule({
      providers: [
        AgentsService,
        AfterCommitService,
        { provide: AuditRecorder, useValue: mockAuditRecorder },
        { provide: PrismaAgentRepository, useValue: agentRepo },
        { provide: AUTH_CFG, useValue: authConfig },
        { provide: TRANSACTION_MANAGER, useValue: txManager },
        { provide: MembershipService, useValue: membership },
        { provide: PermissionService, useValue: permissions },
        {
          provide: KodaDomainWriter,
          useValue: { writeAgentAction: vi.fn().mockResolvedValue({ canonicalId: 'evt-1' }) },
        },
      ],
    }).compile();

    service = testingModule.get(AgentsService);
  });

  afterEach(async () => {
    await testingModule.close();
    vi.clearAllMocks();
  });

  it('AC1: passes create an object whose keys are exactly name, slug, apiKeyHash and maxConcurrentTickets', async () => {
    await service.generateApiKey(
      withClientSuppliedFields({
        name: 'Subrina Coder',
        slug: 'subrina-coder',
        maxConcurrentTickets: 4,
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
    const body = withClientSuppliedFields({ name: 'Subrina Coder', slug: 'subrina-coder' });
    // A legacy client still sends `roles`; the whitelist drops it and nothing writes a role row.
    Object.assign(body, { roles: ['DEVELOPER'] });

    await service.generateApiKey(body);

    const createArg = agentRepo.create.mock.calls[0][0];
    expect(createArg).not.toHaveProperty('status');
    expect(createArg).not.toHaveProperty('id');
    expect(createArg).not.toHaveProperty('roles');
    expect(createArg).not.toHaveProperty('capabilities');
    expect(createArg.name).toBe('Subrina Coder');
    expect(createArg.slug).toBe('subrina-coder');
    expect(createArg.apiKeyHash).toMatch(/^[a-f0-9]{64}$/);
    // AC-9: creation writes no AgentRoleEntry, whatever the body carried.
    expect(agentRepo.createCapabilities).toHaveBeenCalledWith(mockAgent.id, []);
  });

  it('AC1 boundary: uses the provided slug directly', async () => {
    await service.generateApiKey({ name: 'Subrina Coder', slug: 'subrina-coder' });

    const createArg = agentRepo.create.mock.calls[0][0];
    expect(createArg.slug).toBe('subrina-coder');
  });

  it('AC6: rejects with the createCapabilities error and runs both writes in one txManager.run callback', async () => {
    const failure = new Error('agentCapabilityEntry insert failed');
    const writes: Array<{ op: string; runId: number | null }> = [];

    agentRepo.create.mockImplementation(async () => {
      writes.push({ op: 'create', runId: activeRunId });
      return mockAgent;
    });

    agentRepo.createCapabilities.mockImplementation(async () => {
      writes.push({ op: 'createCapabilities', runId: activeRunId });
      throw failure;
    });

    await expect(
      service.generateApiKey({ name: 'Subrina Coder', slug: 'subrina-coder' }),
    ).rejects.toBe(failure);

    expect(writes.map((write) => write.op)).toEqual(['create', 'createCapabilities']);
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

    agentRepo.createCapabilities.mockImplementation(async () => {
      writes.push({ op: 'createCapabilities', runId: activeRunId });
    });

    await service.generateApiKey({ name: 'Subrina Coder', slug: 'subrina-coder' });

    expect(writes.map((write) => write.op)).toEqual(['create', 'createCapabilities']);
    expect(writes[0].runId).not.toBeNull();
    expect(writes[0].runId).toBe(writes[1].runId);
    expect(txManager.run).toHaveBeenCalledTimes(1);
  });

  it('AC-10: writes exactly the capabilities the request named', async () => {
    await service.generateApiKey({
      name: 'Subrina Coder',
      slug: 'subrina-coder',
      capabilities: ['nax'],
    });

    expect(agentRepo.createCapabilities).toHaveBeenCalledTimes(1);
    expect(agentRepo.createCapabilities).toHaveBeenCalledWith(mockAgent.id, ['nax']);
  });

  it('US-004: binds the created agent to the baseline once, inside the create transaction', async () => {
    const bindings: Array<{ principal: unknown; runId: number | null }> = [];
    membership.bindBaseline.mockImplementation(async (principal: unknown) => {
      bindings.push({ principal, runId: activeRunId });
    });

    await service.generateApiKey({ name: 'Subrina Coder', slug: 'subrina-coder' });

    expect(bindings).toEqual([{ principal: { type: 'AGENT', id: mockAgent.id }, runId: 1 }]);
  });
});
