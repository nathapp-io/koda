import { KodaAgentAdapter } from './koda-agent-adapter';
import { AgentRegistryService } from './agent-registry.service';
import { ClaudeCodeAdapter } from './adapters/claude-code.adapter';
import type { ContextBuilderService } from '../context/context-builder.service';
import type { GetProjectContextQuery, GetProjectContextResponse } from '../context/context-builder.service';

describe('KodaAgentAdapter', () => {
  let kodaAgentAdapter: KodaAgentAdapter;
  let mockContextBuilder: jest.Mocked<ContextBuilderService>;
  let registry: AgentRegistryService;

  const mockQuery: GetProjectContextQuery = {
    projectId: 'proj-1',
    actorId: 'agent-123',
    intent: 'diagnose',
    query: 'login bug',
  };

  const mockContext: GetProjectContextResponse = {
    projectId: 'proj-1',
    canonicalState: {
      tickets: [
        {
          id: 'ticket-1',
          title: 'Fix login bug',
          status: 'IN_PROGRESS',
          priority: 'CRITICAL',
          assignedToUserId: null,
          assignedToAgentId: null,
          createdAt: new Date('2025-01-01'),
          updatedAt: new Date('2025-01-02'),
        },
      ],
      recentEvents: [],
      activeDecisions: [],
    },
    retrievedContext: {
      documents: { results: [], scores: [], retrievedAt: '2025-01-02T00:00:00Z' },
      semanticMemory: [],
      graphPaths: [],
      codeIntel: [],
    },
    provenance: {
      sources: [],
      retrievalStrategy: 'canonical-only',
    },
    meta: {
      intent: 'diagnose',
      tokensUsed: 100,
      retrievedAt: new Date('2025-01-02'),
      latencyMs: 30,
    },
  };

  beforeEach(() => {
    mockContextBuilder = {
      getProjectContext: jest.fn(),
    } as unknown as jest.Mocked<ContextBuilderService>;

    registry = new AgentRegistryService();
    registry.register('claude-code', new ClaudeCodeAdapter());

    kodaAgentAdapter = new KodaAgentAdapter(mockContextBuilder, registry);
  });

  // AC5: KodaAgentAdapter.getContextForAgent(agentId, query)
  // calls ContextBuilderService.getProjectContext() and then
  // registry.getAdapter(agentId).formatContext()
  describe('getContextForAgent', () => {
    it('should call ContextBuilderService.getProjectContext with the query', async () => {
      mockContextBuilder.getProjectContext.mockResolvedValue(mockContext);

      await kodaAgentAdapter.getContextForAgent('claude-code', mockQuery);

      expect(mockContextBuilder.getProjectContext).toHaveBeenCalledTimes(1);
      expect(mockContextBuilder.getProjectContext).toHaveBeenCalledWith(mockQuery);
    });

    it('should format context using the correct adapter', async () => {
      mockContextBuilder.getProjectContext.mockResolvedValue(mockContext);

      const result = await kodaAgentAdapter.getContextForAgent('claude-code', mockQuery);

      expect(typeof result).toBe('string');
      expect(result).toContain('Fix login bug');
      expect(result).toContain('<project-context>');
    });

    it('should throw when adapter is not registered for agentId', async () => {
      mockContextBuilder.getProjectContext.mockResolvedValue(mockContext);

      await expect(
        kodaAgentAdapter.getContextForAgent('unknown-agent', mockQuery),
      ).rejects.toThrow();
    });

    it('should propagate errors from ContextBuilderService', async () => {
      const error = new Error('Context build failed');
      mockContextBuilder.getProjectContext.mockRejectedValue(error);

      await expect(
        kodaAgentAdapter.getContextForAgent('claude-code', mockQuery),
      ).rejects.toThrow('Context build failed');
    });

    it('should return the exact output from adapter.formatContext', async () => {
      mockContextBuilder.getProjectContext.mockResolvedValue(mockContext);

      const result = await kodaAgentAdapter.getContextForAgent('claude-code', mockQuery);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
