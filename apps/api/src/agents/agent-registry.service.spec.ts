import { AgentRegistryService } from './agent-registry.service';
import { ClaudeCodeAdapter } from './adapters/claude-code.adapter';
import { NaxAdapter } from './adapters/nax.adapter';
import type {
  AgentAdapter,
  AgentCapability,
  AgentInfo,
} from './agent-registry.service';
import type { GetProjectContextResponse } from '../context/context-builder.service';

const makeContext = (
  overrides?: Partial<GetProjectContextResponse>,
): GetProjectContextResponse => ({
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
    recentEvents: [
      {
        id: 'evt-1',
        eventType: 'STATUS_CHANGE',
        actorId: 'user-1',
        action: 'status_change',
        payload: { from: 'CREATED', to: 'IN_PROGRESS' },
        rationale: null,
        createdAt: new Date('2025-01-02'),
      },
    ],
    activeDecisions: [],
  },
  retrievedContext: {
    documents: {
      results: [
        {
          id: 'doc-1',
          source: 'code' as const,
          sourceId: 'src/auth.ts',
          score: 0.95,
          content: 'login handler code',
          similarity: 'high' as const,
          metadata: {},
          createdAt: '2025-01-02T00:00:00Z',
          provenance: {
            indexedAt: '2025-01-01T00:00:00Z',
            sourceProjectId: 'proj-1',
          },
        },
      ],
      scores: [
        {
          vectorScore: 0.9,
          lexicalScore: 0.8,
          entityScore: 1.0,
          recencyScore: 0.7,
          finalScore: 0.95,
        },
      ],
      retrievedAt: '2025-01-02T00:00:00Z',
    },
    semanticMemory: [
      {
        id: 'mem-1',
        projectId: 'proj-1',
        kind: 'FACT',
        subject: 'Auth module',
        predicate: 'uses',
        object: 'bcrypt',
        status: 'active',
        confidence: 0.9,
        createdAt: new Date('2025-01-01'),
        updatedAt: new Date('2025-01-01'),
      },
    ],
    graphPaths: [],
    codeIntel: [],
  },
  provenance: {
    sources: [{ sourceType: 'code', sourceId: 'src/auth.ts', score: 0.95 }],
    retrievalStrategy: 'hybrid',
  },
  meta: {
    intent: 'answer',
    tokensUsed: 500,
    retrievedAt: new Date('2025-01-02'),
    latencyMs: 45,
  },
  ...overrides,
});

describe('AgentRegistryService', () => {
  let registry: AgentRegistryService;

  beforeEach(() => {
    registry = new AgentRegistryService();
  });

  // AC1: register() stores the adapter and it is retrievable by agentId via getAdapter()
  describe('register and getAdapter', () => {
    it('should store and retrieve an adapter by agentId', () => {
      const adapter: AgentAdapter = {
        agentId: 'claude-code',
        name: 'Claude Code',
        capabilities: ['ticket_ops' as AgentCapability, 'code_write' as AgentCapability],
        formatContext: jest.fn(),
      };

      registry.register('claude-code', adapter);
      const retrieved = registry.getAdapter('claude-code');

      expect(retrieved).toBe(adapter);
      expect(retrieved.agentId).toBe('claude-code');
      expect(retrieved.name).toBe('Claude Code');
    });

    it('should throw when adapter is not found', () => {
      expect(() => registry.getAdapter('unknown-agent')).toThrow();
    });
  });

  // AC2: getAdapter('claude-code') returns an adapter with formatContext()
  // that formats GetProjectContextResponse as a Claude Code prompt fragment
  describe('claude-code adapter', () => {
    it('should format context as a Claude Code prompt fragment', () => {
      const claudeAdapter = new ClaudeCodeAdapter();
      registry.register('claude-code', claudeAdapter);

      const adapter = registry.getAdapter('claude-code');
      const ctx = makeContext();
      const result = adapter.formatContext(ctx);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('Fix login bug');
      expect(result).toContain('CRITICAL');
      expect(result).toContain('Auth module');
    });

    it('should include project canonical state and retrieved context sections', () => {
      const claudeAdapter = new ClaudeCodeAdapter();
      registry.register('claude-code', claudeAdapter);

      const adapter = registry.getAdapter('claude-code');
      const ctx = makeContext();
      const result = adapter.formatContext(ctx);

      expect(result).toContain('<project-context>');
      expect(result).toContain('Canonical State');
      expect(result).toContain('Retrieved Context');
    });
  });

  // AC3: getAdapter('nax') returns adapter with formatContext()
  // that formats GetProjectContextResponse for nax prompt injection
  describe('nax adapter', () => {
    it('should format context for nax prompt injection', () => {
      const naxAdapter = new NaxAdapter();
      registry.register('nax', naxAdapter);

      const adapter = registry.getAdapter('nax');
      const ctx = makeContext();
      const result = adapter.formatContext(ctx);

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('Fix login bug');
      expect(result).toContain('IN_PROGRESS');
      expect(result).toContain('Auth module');
    });

    it('should format context with nax-specific structure', () => {
      const naxAdapter = new NaxAdapter();
      registry.register('nax', naxAdapter);

      const adapter = registry.getAdapter('nax');
      const ctx = makeContext();
      const result = adapter.formatContext(ctx);

      expect(result).toContain('===');
    });
  });

  // AC4: Calling register() twice with the same agentId replaces the existing adapter
  describe('re-registration', () => {
    it('should replace the existing adapter when registered twice with the same agentId', () => {
      const firstAdapter: AgentAdapter = {
        agentId: 'claude-code',
        name: 'Claude Code v1',
        capabilities: ['ticket_ops' as AgentCapability],
        formatContext: jest.fn().mockReturnValue('v1 output'),
      };

      const secondAdapter: AgentAdapter = {
        agentId: 'claude-code',
        name: 'Claude Code v2',
        capabilities: ['ticket_ops' as AgentCapability, 'code_write' as AgentCapability],
        formatContext: jest.fn().mockReturnValue('v2 output'),
      };

      registry.register('claude-code', firstAdapter);
      registry.register('claude-code', secondAdapter);

      const retrieved = registry.getAdapter('claude-code');
      expect(retrieved).toBe(secondAdapter);
      expect(retrieved.name).toBe('Claude Code v2');
      expect(retrieved.formatContext(makeContext())).toBe('v2 output');
    });
  });

  // AC1 (spec-correctness): register() must validate that the agentId parameter
  // matches the adapter's own agentId property. Otherwise the adapter's metadata
  // (agentId, name, capabilities) disagrees with the registry key, violating the
  // invariant that the adapter is retrievable by its agentId.
  describe('agentId consistency', () => {
    it('should throw when agentId does not match adapter.agentId', () => {
      const adapter: AgentAdapter = {
        agentId: 'my-agent',
        name: 'My Agent',
        capabilities: ['ticket_ops' as AgentCapability],
        formatContext: jest.fn(),
      };

      expect(() => registry.register('different-id', adapter)).toThrow();
    });

    it('should make adapter retrievable by adapter.agentId regardless of register key', () => {
      const claudeAdapter = new ClaudeCodeAdapter(); // adapter.agentId = 'claude-code'

      registry.register('any-other-key', claudeAdapter);

      // AC1: the adapter must be retrievable by its own agentId
      expect(() => registry.getAdapter('claude-code')).not.toThrow();
      expect(registry.getAdapter('claude-code')).toBe(claudeAdapter);
    });

    it('should detect mismatch with real ClaudeCodeAdapter registered under wrong key', () => {
      const claudeAdapter = new ClaudeCodeAdapter(); // agentId = 'claude-code'

      expect(() => registry.register('nax', claudeAdapter)).toThrow();
    });

    it('should detect mismatch with real NaxAdapter registered under wrong key', () => {
      const naxAdapter = new NaxAdapter(); // agentId = 'nax'

      expect(() => registry.register('claude-code', naxAdapter)).toThrow();
    });
  });

  // AC7: Adapters cannot call retrieval, memory, graph, or code-intel services directly
  describe('adapter isolation', () => {
    it('should only expose formatContext and metadata, not service access', () => {
      registry.register('nax', new NaxAdapter());

      const adapter = registry.getAdapter('nax');

      expect(adapter.agentId).toBeDefined();
      expect(adapter.name).toBeDefined();
      expect(adapter.capabilities).toBeDefined();
      expect(typeof adapter.formatContext).toBe('function');

      // The adapter interface is limited to agent metadata + formatContext
      const ownKeys = Object.keys(adapter);
      expect(ownKeys).toEqual(
        expect.arrayContaining(['agentId', 'name', 'capabilities']),
      );
      expect(typeof adapter.formatContext).toBe('function');
    });

    it('should have no way to call external services from adapter interface', () => {
      registry.register('claude-code', new ClaudeCodeAdapter());

      const adapter = registry.getAdapter('claude-code') as unknown as Record<string, unknown>;

      // Verify no retrieval/memory/graph/code-intel methods exist
      const forbiddenMethods = ['retrieve', 'search', 'query', 'fetch', 'getEntities', 'analyze'];
      for (const method of forbiddenMethods) {
        expect(adapter).not.toHaveProperty(method);
      }
    });
  });

  // listAgents
  describe('listAgents', () => {
    it('should return all registered agents as AgentInfo', () => {
      registry.register('claude-code', new ClaudeCodeAdapter());
      registry.register('nax', new NaxAdapter());

      const agents: AgentInfo[] = registry.listAgents();

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentId)).toEqual(
        expect.arrayContaining(['claude-code', 'nax']),
      );

      const claudeInfo = agents.find((a) => a.agentId === 'claude-code');
      expect(claudeInfo).toBeDefined();
      expect(claudeInfo?.name).toBe('Claude Code');
      expect(claudeInfo.capabilities).toEqual(
        expect.arrayContaining(['ticket_ops', 'code_search', 'code_write', 'planning']),
      );
    });
  });
});
