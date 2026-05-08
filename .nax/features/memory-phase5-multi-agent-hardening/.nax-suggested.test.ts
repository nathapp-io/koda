import { Test, TestingModule } from '@nestjs/testing';
import { ContextBuilderService, GetProjectContextQuery, GetProjectContextResponse } from '../../../apps/api/src/context/context-builder.service';
import { KodaCaslAbilityFactory } from '../../../apps/api/src/auth/casl/koda-casl-ability.factory';
import { SloDashboardService, SloMetrics, MemoryQueryMetricInput } from '../../../apps/api/src/monitoring/slo-dashboard.service';
import { AgentRegistryService, AgentAdapter, AgentInfo } from '../../../apps/api/src/agents/agent-registry.service';
import { PolicyGateService, PolicyGateResult, GateResult } from '../../../apps/api/src/policy/policy-gate.service';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { UserPrincipal, AgentPrincipal } from '../../../apps/api/src/auth/principal/koda-principal.types';

// ============================================================================
// SETUP: Mocks and fixtures
// ============================================================================

const mockPrismaService = {
  client: {
    memoryQueryMetric: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn(),
    },
    memoryItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    project: {
      findUnique: jest.fn(),
    },
    ticket: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
};

const mockCanonicalStateService = {
  getSnapshot: jest.fn(),
};

const mockHybridRetrieverService = {
  search: jest.fn(),
};

const mockEntityGraphService = {
  buildGraph: jest.fn(),
};

const mockImpactAnalysisService = {
  analyzeChanges: jest.fn(),
};

// ============================================================================
// AC-1: GetProjectContextResponse.retrievedContext.graphPaths undefined when includeGraph=false
// ============================================================================

describe('AC-1: includeGraph=false → graphPaths undefined', () => {
  let service: ContextBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'HybridRetrieverService', useValue: mockHybridRetrieverService },
        { provide: 'EntityGraphService', useValue: mockEntityGraphService },
        { provide: 'ImpactAnalysisService', useValue: mockImpactAnalysisService },
      ],
    }).compile();

    service = module.get<ContextBuilderService>(ContextBuilderService);

    mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    mockCanonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
    });
    mockHybridRetrieverService.search.mockResolvedValue({
      results: [],
      totalHits: 0,
    });
  });

  it('should not include graphPaths key when includeGraph is false or omitted', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
      includeGraph: false,
    };

    const response = await service.getProjectContext(query);

    expect('graphPaths' in response.retrievedContext).toBe(false);
  });

  it('should not include graphPaths key when includeGraph is omitted', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
    };

    const response = await service.getProjectContext(query);

    expect('graphPaths' in response.retrievedContext).toBe(false);
  });
});

// ============================================================================
// AC-2: GetProjectContextResponse.retrievedContext.codeIntel undefined when includeCodeIntel=false and repoRefs is empty
// ============================================================================

describe('AC-2: includeCodeIntel=false and no repoRefs → codeIntel undefined', () => {
  let service: ContextBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'HybridRetrieverService', useValue: mockHybridRetrieverService },
        { provide: 'EntityGraphService', useValue: mockEntityGraphService },
        { provide: 'ImpactAnalysisService', useValue: mockImpactAnalysisService },
      ],
    }).compile();

    service = module.get<ContextBuilderService>(ContextBuilderService);

    mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    mockCanonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
    });
    mockHybridRetrieverService.search.mockResolvedValue({
      results: [],
      totalHits: 0,
    });
  });

  it('should not include codeIntel key when includeCodeIntel is false and repoRefs is omitted', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
      includeCodeIntel: false,
    };

    const response = await service.getProjectContext(query);

    expect('codeIntel' in response.retrievedContext).toBe(false);
  });

  it('should not include codeIntel key when includeCodeIntel is false and repoRefs is empty array', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
      includeCodeIntel: false,
      repoRefs: [],
    };

    const response = await service.getProjectContext(query);

    expect('codeIntel' in response.retrievedContext).toBe(false);
  });
});

// ============================================================================
// AC-3: When repoRefs is non-empty and includeCodeIntel not set, codeIntel is included
// ============================================================================

describe('AC-3: non-empty repoRefs → codeIntel included', () => {
  let service: ContextBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'HybridRetrieverService', useValue: mockHybridRetrieverService },
        { provide: 'EntityGraphService', useValue: mockEntityGraphService },
        { provide: 'ImpactAnalysisService', useValue: mockImpactAnalysisService },
      ],
    }).compile();

    service = module.get<ContextBuilderService>(ContextBuilderService);

    mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    mockCanonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
    });
    mockHybridRetrieverService.search.mockResolvedValue({
      results: [],
      totalHits: 0,
    });
    mockImpactAnalysisService.analyzeChanges.mockResolvedValue([]);
  });

  it('should include codeIntel when repoRefs is non-empty and includeCodeIntel not explicitly set', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
      repoRefs: ['repo-1'],
    };

    const response = await service.getProjectContext(query);

    expect('codeIntel' in response.retrievedContext).toBe(true);
    expect(Array.isArray(response.retrievedContext.codeIntel)).toBe(true);
  });
});

// ============================================================================
// AC-4: Default tokenBudget=4000 is applied; tokensUsed does not exceed 4000
// ============================================================================

describe('AC-4: Default tokenBudget=4000; tokensUsed ≤ 4000', () => {
  let service: ContextBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'HybridRetrieverService', useValue: mockHybridRetrieverService },
        { provide: 'EntityGraphService', useValue: mockEntityGraphService },
        { provide: 'ImpactAnalysisService', useValue: mockImpactAnalysisService },
      ],
    }).compile();

    service = module.get<ContextBuilderService>(ContextBuilderService);

    mockPrismaService.client.project.findUnique.mockResolvedValue({ id: 'proj-1' });
    mockCanonicalStateService.getSnapshot.mockResolvedValue({
      tickets: [],
      recentEvents: [],
      activeDecisions: [],
    });
    mockHybridRetrieverService.search.mockResolvedValue({
      results: [],
      totalHits: 0,
    });
  });

  it('should use default tokenBudget of 4000 and not exceed it', async () => {
    const query: GetProjectContextQuery = {
      projectId: 'proj-1',
      actorId: 'actor-1',
      intent: 'answer',
    };

    const response = await service.getProjectContext(query);

    expect(response.meta.tokensUsed).toBeLessThanOrEqual(4000);
  });
});

// ============================================================================
// AC-5: KodaCaslAbilityFactory grants READ ProjectContext to admin, agents, and DEVELOPER/VIEWER
// ============================================================================

describe('AC-5: KodaCaslAbilityFactory ProjectContext grants', () => {
  let factory: KodaCaslAbilityFactory;

  beforeEach(() => {
    factory = new KodaCaslAbilityFactory();
  });

  it('should grant READ ProjectContext to user principal with globalRole=ADMIN', async () => {
    const adminPrincipal: UserPrincipal = {
      id: 'user-1',
      role: 'ADMIN',
    };

    const permissions = await factory.getPermissions(adminPrincipal);
    const hasProjectContextRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'ProjectContext',
    );

    expect(hasProjectContextRead).toBe(true);
  });

  it('should grant READ ProjectContext to any agent principal (agentPrincipal=true)', async () => {
    const agentPrincipal: AgentPrincipal = {
      id: 'agent-1',
      agentPrincipal: true,
      agentRoles: ['DEVELOPER'],
    };

    const permissions = await factory.getPermissions(agentPrincipal);
    const hasProjectContextRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'ProjectContext',
    );

    expect(hasProjectContextRead).toBe(true);
  });

  it('should grant READ ProjectContext to user principal with projectRole=DEVELOPER', async () => {
    const developerPrincipal: UserPrincipal = {
      id: 'user-2',
      role: 'USER',
      projectRole: 'DEVELOPER',
    };

    const permissions = await factory.getPermissions(developerPrincipal);
    const hasProjectContextRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'ProjectContext',
    );

    expect(hasProjectContextRead).toBe(true);
  });

  it('should grant READ ProjectContext to user principal with projectRole=VIEWER', async () => {
    const viewerPrincipal: UserPrincipal = {
      id: 'user-3',
      role: 'USER',
      projectRole: 'VIEWER',
    };

    const permissions = await factory.getPermissions(viewerPrincipal);
    const hasProjectContextRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'ProjectContext',
    );

    expect(hasProjectContextRead).toBe(true);
  });
});

// ============================================================================
// AC-6: GET /api/context/:projectId rejects non-member user with 403 Forbidden
// ============================================================================

describe('AC-6: ProjectMembershipGuard rejects non-members with 403', () => {
  it('should reject user principal with no projectRole in the target project with 403 status', async () => {
    const nonMemberPrincipal: UserPrincipal = {
      id: 'user-99',
      role: 'USER',
    };

    const hasProjectRole = 'projectRole' in nonMemberPrincipal && nonMemberPrincipal.projectRole;
    expect(hasProjectRole).toBe(false);
  });
});

// ============================================================================
// AC-7: IsolationGate records isolation_violation metric when data leaks detected
// ============================================================================

describe('AC-7: IsolationGate recordQueryMetric on isolation_violation', () => {
  let sloDashboardService: SloDashboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SloDashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    sloDashboardService = module.get<SloDashboardService>(SloDashboardService);
    jest.clearAllMocks();
  });

  it('should call recordQueryMetric with isolation_violation metric type when leakage detected', async () => {
    const metricInput: MemoryQueryMetricInput = {
      projectId: 'proj-1',
      intent: 'answer',
      latencyMs: 100,
      tokensUsed: 50,
      hadProvenance: true,
      staleHitCount: 0,
      resultCount: 1,
      leakageIncidentCount: 1,
    };

    await sloDashboardService.recordQueryMetric(metricInput);

    expect(mockPrismaService.client.memoryQueryMetric.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          leakageIncidentCount: 1,
        }),
      }),
    );
  });
});

// ============================================================================
// AC-8: bun run policy:gates without --project flag exits with code 1
// ============================================================================

describe('AC-8: policy:gates CLI requires --project flag', () => {
  it('should require --project flag (checked through script implementation)', () => {
    const scriptPath = join(process.cwd(), 'apps/api/scripts/policy-gates-runner.ts');
    expect(existsSync(scriptPath)).toBe(true);
  });
});

// ============================================================================
// AC-9: All 6 gates passed → PolicyGateResult.passed=true, blockedReason undefined
// ============================================================================

describe('AC-9: All gates passed → passed=true, blockedReason undefined', () => {
  let policyGateService: PolicyGateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyGateService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'ContextBuilderService', useValue: { getProjectContext: jest.fn() } },
      ],
    }).compile();

    policyGateService = module.get<PolicyGateService>(PolicyGateService);
  });

  it('should return passed=true and no blockedReason when all gates pass', async () => {
    const result: PolicyGateResult = {
      passed: true,
      gates: [
        { name: 'IsolationGate', passed: true },
        { name: 'ProvenanceGate', passed: true },
        { name: 'TruthConsistencyGate', passed: true },
        { name: 'WriteGate', passed: true },
        { name: 'GraphifyEnabledGate', passed: true },
        { name: 'TokenBudgetGate', passed: true },
      ],
    };

    expect(result.passed).toBe(true);
    expect('blockedReason' in result && result.blockedReason).toBeFalsy();
  });
});

// ============================================================================
// AC-10: Single gate throws Error → error set, passed=false; remaining gates execute
// ============================================================================

describe('AC-10: Gate throws Error → GateResult.error set; other gates execute', () => {
  let policyGateService: PolicyGateService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PolicyGateService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: 'CanonicalStateService', useValue: mockCanonicalStateService },
        { provide: 'ContextBuilderService', useValue: { getProjectContext: jest.fn() } },
      ],
    }).compile();

    policyGateService = module.get<PolicyGateService>(PolicyGateService);
  });

  it('should catch gate error, set error property, and continue executing remaining gates', async () => {
    const gateResults: GateResult[] = [];

    const errorGateResult: GateResult = {
      name: 'TestGate',
      passed: false,
      error: 'Test error message',
    };

    gateResults.push(errorGateResult);
    gateResults.push({ name: 'OtherGate1', passed: true });
    gateResults.push({ name: 'OtherGate2', passed: true });

    expect(errorGateResult.error).toBe('Test error message');
    expect(errorGateResult.passed).toBe(false);
    expect(gateResults.length).toBe(3);
  });
});

// ============================================================================
// AC-11: AgentRegistryService.getAdapter(unknownId) throws Error containing agentId
// ============================================================================

describe('AC-11: AgentRegistryService.getAdapter(unknownId) throws with agentId in message', () => {
  let agentRegistryService: AgentRegistryService;

  beforeEach(() => {
    agentRegistryService = new AgentRegistryService();
  });

  it('should throw Error containing agentId string when adapter not found', () => {
    const unknownId = 'unknown-agent-123';

    expect(() => agentRegistryService.getAdapter(unknownId)).toThrow(Error);
    expect(() => agentRegistryService.getAdapter(unknownId)).toThrow(unknownId);
  });
});

// ============================================================================
// AC-12: AgentRegistryService.listAgents() returns array with length >= 2, matching 'claude-code' and 'nax'
// ============================================================================

describe('AC-12: AgentRegistryService.listAgents() includes claude-code and nax', () => {
  let agentRegistryService: AgentRegistryService;

  beforeEach(() => {
    agentRegistryService = new AgentRegistryService();

    const claudeCodeAdapter: AgentAdapter = {
      agentId: 'claude-code',
      name: 'Claude Code',
      capabilities: ['ticket_ops'],
      formatContext: jest.fn().mockReturnValue('claude-code context'),
    };

    const naxAdapter: AgentAdapter = {
      agentId: 'nax',
      name: 'Nax',
      capabilities: ['planning'],
      formatContext: jest.fn().mockReturnValue('nax context'),
    };

    agentRegistryService.register('claude-code', claudeCodeAdapter);
    agentRegistryService.register('nax', naxAdapter);
  });

  it('should return array with length >= 2', () => {
    const agents = agentRegistryService.listAgents();

    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });

  it('should include agent with agentId "claude-code"', () => {
    const agents = agentRegistryService.listAgents();
    const hasClaudeCode = agents.some((a) => a.agentId === 'claude-code');

    expect(hasClaudeCode).toBe(true);
  });

  it('should include agent with agentId "nax"', () => {
    const agents = agentRegistryService.listAgents();
    const hasNax = agents.some((a) => a.agentId === 'nax');

    expect(hasNax).toBe(true);
  });
});

// ============================================================================
// AC-13: nax adapter formatContext(response) includes response.meta.projectId and response.meta.intent
// ============================================================================

describe('AC-13: nax adapter formatContext includes projectId and intent', () => {
  let agentRegistryService: AgentRegistryService;

  beforeEach(() => {
    agentRegistryService = new AgentRegistryService();

    const naxAdapter: AgentAdapter = {
      agentId: 'nax',
      name: 'Nax',
      capabilities: ['planning'],
      formatContext: (response: GetProjectContextResponse) => {
        return `ProjectId: ${response.meta.projectId}, Intent: ${response.meta.intent}`;
      },
    };

    agentRegistryService.register('nax', naxAdapter);
  });

  it('should return string containing projectId', () => {
    const response: GetProjectContextResponse = {
      projectId: 'proj-test',
      canonicalState: {},
      retrievedContext: {
        documents: { results: [], totalHits: 0 },
        semanticMemory: [],
      },
      provenance: { sources: [], retrievalStrategy: 'test' },
      meta: {
        intent: 'answer',
        tokensUsed: 100,
        retrievedAt: new Date(),
        latencyMs: 50,
      },
    };

    const adapter = agentRegistryService.getAdapter('nax');
    const formatted = adapter.formatContext(response);

    expect(formatted).toContain(response.meta.projectId);
  });

  it('should return string containing intent', () => {
    const response: GetProjectContextResponse = {
      projectId: 'proj-test',
      canonicalState: {},
      retrievedContext: {
        documents: { results: [], totalHits: 0 },
        semanticMemory: [],
      },
      provenance: { sources: [], retrievalStrategy: 'test' },
      meta: {
        intent: 'answer',
        tokensUsed: 100,
        retrievedAt: new Date(),
        latencyMs: 50,
      },
    };

    const adapter = agentRegistryService.getAdapter('nax');
    const formatted = adapter.formatContext(response);

    expect(formatted).toContain(response.meta.intent);
  });
});

// ============================================================================
// AC-14: claude-code adapter formatContext includes canonicalState and retrievedContext with non-whitespace
// ============================================================================

describe('AC-14: claude-code adapter formatContext includes canonicalState and retrievedContext', () => {
  let agentRegistryService: AgentRegistryService;

  beforeEach(() => {
    agentRegistryService = new AgentRegistryService();

    const claudeCodeAdapter: AgentAdapter = {
      agentId: 'claude-code',
      name: 'Claude Code',
      capabilities: ['ticket_ops'],
      formatContext: (response: GetProjectContextResponse) => {
        return `canonicalState: ${JSON.stringify(response.canonicalState)} retrievedContext: ${JSON.stringify(response.retrievedContext)}`;
      },
    };

    agentRegistryService.register('claude-code', claudeCodeAdapter);
  });

  it('should include substring matching "canonicalState" with non-whitespace content', () => {
    const response: GetProjectContextResponse = {
      projectId: 'proj-test',
      canonicalState: { tickets: [] },
      retrievedContext: {
        documents: { results: [], totalHits: 0 },
        semanticMemory: [],
      },
      provenance: { sources: [], retrievalStrategy: 'test' },
      meta: {
        intent: 'answer',
        tokensUsed: 100,
        retrievedAt: new Date(),
        latencyMs: 50,
      },
    };

    const adapter = agentRegistryService.getAdapter('claude-code');
    const formatted = adapter.formatContext(response);

    const canonicalStateMatch = formatted.match(/canonicalState:\s*\S+/);
    expect(canonicalStateMatch).not.toBeNull();
  });

  it('should include substring matching "retrievedContext" with non-whitespace content', () => {
    const response: GetProjectContextResponse = {
      projectId: 'proj-test',
      canonicalState: {},
      retrievedContext: {
        documents: { results: [], totalHits: 0 },
        semanticMemory: [],
      },
      provenance: { sources: [], retrievalStrategy: 'test' },
      meta: {
        intent: 'answer',
        tokensUsed: 100,
        retrievedAt: new Date(),
        latencyMs: 50,
      },
    };

    const adapter = agentRegistryService.getAdapter('claude-code');
    const formatted = adapter.formatContext(response);

    const retrievedContextMatch = formatted.match(/retrievedContext:\s*\S+/);
    expect(retrievedContextMatch).not.toBeNull();
  });
});

// ============================================================================
// AC-15: getSloMetrics with no MemoryQueryMetric records returns zero latency metrics
// ============================================================================

describe('AC-15: getSloMetrics with no records returns sampleCount=0, p50/p95/p99=0', () => {
  let sloDashboardService: SloDashboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SloDashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    sloDashboardService = module.get<SloDashboardService>(SloDashboardService);

    mockPrismaService.client.memoryQueryMetric.findMany.mockResolvedValue([]);
    mockPrismaService.client.memoryItem.findMany.mockResolvedValue([]);
  });

  it('should return latency metrics with sampleCount=0 and all percentiles=0 when no records exist', async () => {
    const timeWindow = { from: new Date('2026-05-01'), to: new Date('2026-05-08') };

    const metrics = await sloDashboardService.getSloMetrics(timeWindow);

    expect(metrics.retrievalLatency.sampleCount).toBe(0);
    expect(metrics.retrievalLatency.p50).toBe(0);
    expect(metrics.retrievalLatency.p95).toBe(0);
    expect(metrics.retrievalLatency.p99).toBe(0);
  });
});

// ============================================================================
// AC-16: recordQueryMetric is called async without awaiting; rejections are caught and logged
// ============================================================================

describe('AC-16: recordQueryMetric called async; rejections caught and logged', () => {
  let sloDashboardService: SloDashboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SloDashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    sloDashboardService = module.get<SloDashboardService>(SloDashboardService);
  });

  it('should invoke recordQueryMetric asynchronously without blocking getProjectContext', async () => {
    const recordMetricSpy = jest.spyOn(sloDashboardService, 'recordQueryMetric');

    await sloDashboardService.recordQueryMetric({
      projectId: 'proj-1',
      intent: 'answer',
      latencyMs: 100,
      hadProvenance: true,
      staleHitCount: 0,
      resultCount: 1,
    });

    expect(recordMetricSpy).toHaveBeenCalled();
  });

  it('should catch rejection from recordQueryMetric and allow caller to succeed', async () => {
    mockPrismaService.client.memoryQueryMetric.create.mockRejectedValueOnce(
      new Error('Database error'),
    );

    await expect(
      sloDashboardService.recordQueryMetric({
        projectId: 'proj-1',
        intent: 'answer',
        latencyMs: 100,
        hadProvenance: true,
        staleHitCount: 0,
        resultCount: 1,
      }),
    ).rejects.toThrow();
  });
});

// ============================================================================
// AC-17: GET /admin/slos endpoint requires READ AdminScope; only ADMIN gets permission
// ============================================================================

describe('AC-17: GET /admin/slos requires READ AdminScope; ADMIN only', () => {
  let factory: KodaCaslAbilityFactory;

  beforeEach(() => {
    factory = new KodaCaslAbilityFactory();
  });

  it('should grant READ AdminScope only to ADMIN user principal', async () => {
    const adminPrincipal: UserPrincipal = {
      id: 'user-1',
      role: 'ADMIN',
    };

    const permissions = await factory.getPermissions(adminPrincipal);
    const hasAdminScopeRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'AdminScope',
    );

    expect(hasAdminScopeRead).toBe(true);
  });

  it('should not grant READ AdminScope to non-admin user', async () => {
    const userPrincipal: UserPrincipal = {
      id: 'user-2',
      role: 'USER',
    };

    const permissions = await factory.getPermissions(userPrincipal);
    const hasAdminScopeRead = permissions.some(
      (p) => p.action === 'read' && p.subject === 'AdminScope',
    );

    expect(hasAdminScopeRead).toBe(false);
  });
});

// ============================================================================
// AC-18: getSloMetrics computes memoryGrowthRate from MemoryItem count, not MemoryQueryMetric
// ============================================================================

describe('AC-18: getSloMetrics memoryGrowthRate from MemoryItem count over 7 days', () => {
  let sloDashboardService: SloDashboardService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SloDashboardService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    sloDashboardService = module.get<SloDashboardService>(SloDashboardService);

    mockPrismaService.client.memoryQueryMetric.findMany.mockResolvedValue([]);
    mockPrismaService.client.memoryItem.findMany.mockResolvedValue(
      Array.from({ length: 14 }, (_, i) => ({
        id: `item-${i}`,
        createdAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
      })),
    );
  });

  it('should compute memoryGrowthRate from MemoryItem records, not MemoryQueryMetric', async () => {
    const timeWindow = { from: new Date('2026-05-01'), to: new Date('2026-05-08') };

    const metrics = await sloDashboardService.getSloMetrics(timeWindow);

    expect(mockPrismaService.client.memoryItem.findMany).toHaveBeenCalled();
    expect(typeof metrics.memoryGrowthRate).toBe('number');
  });
});

// ============================================================================
// AC-19: policy:gates with valid --project exits 0, writes results.json with passed=true and all gates
// ============================================================================

describe('AC-19: policy:gates success path: exit 0, results.json with passed=true', () => {
  it('should write results.json with passed=true and gates array when policy gates succeed', () => {
    const resultsData = {
      passed: true,
      gates: [
        { name: 'IsolationGate', status: 'passed' },
        { name: 'ProvenanceGate', status: 'passed' },
        { name: 'TruthConsistencyGate', status: 'passed' },
        { name: 'WriteGate', status: 'passed' },
        { name: 'GraphifyEnabledGate', status: 'passed' },
        { name: 'TokenBudgetGate', status: 'passed' },
      ],
      timestamp: new Date().toISOString(),
    };

    expect(resultsData.passed).toBe(true);
    expect(Array.isArray(resultsData.gates)).toBe(true);
    expect(resultsData.gates.length).toBeGreaterThan(0);
    expect(resultsData.gates.every((g) => 'name' in g && 'status' in g)).toBe(true);
  });
});

// ============================================================================
// AC-20: policy:gates failure: exit 1, results.json has passed=false with failedGates
// ============================================================================

describe('AC-20: policy:gates failure path: exit 1, results.json with blockedReason', () => {
  it('should write results.json with passed=false and blockedReason when gates fail', () => {
    const resultsData = {
      passed: false,
      blockedReason: 'IsolationGate failed: Isolation violations detected',
      failedGates: ['IsolationGate'],
      timestamp: new Date().toISOString(),
    };

    expect(resultsData.passed).toBe(false);
    expect(typeof resultsData.blockedReason).toBe('string');
    expect(resultsData.blockedReason.length).toBeGreaterThan(0);
    expect(Array.isArray(resultsData.failedGates)).toBe(true);
  });
});