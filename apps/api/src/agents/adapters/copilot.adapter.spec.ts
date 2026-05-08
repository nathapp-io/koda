import { CopilotAdapter } from './copilot.adapter';
import type { GetProjectContextResponse } from '../../context/context-builder.service';

const baseContext: GetProjectContextResponse = {
  projectId: 'proj-1',
  canonicalState: {},
  retrievedContext: {
    documents: { results: [], scores: [], retrievedAt: '2025-01-02T00:00:00Z' },
    semanticMemory: [],
  },
  provenance: {
    sources: [],
    retrievalStrategy: 'canonical-only',
  },
  meta: {
    intent: 'diagnose',
    tokensUsed: 100,
    retrievedAt: new Date('2025-01-02'),
    latencyMs: 50,
  },
};

describe('CopilotAdapter formatContext', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('should wrap output in HTML comment markers', () => {
    const result = adapter.formatContext(baseContext);
    expect(result).toContain('<!-- koda-context -->');
    expect(result).toContain('<!-- /koda-context -->');
  });

  it('should not throw when canonicalState.recentEvents is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: { ...baseContext.canonicalState, recentEvents: undefined },
    };
    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when canonicalState.activeDecisions is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: { ...baseContext.canonicalState, activeDecisions: undefined },
    };
    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when canonicalState.tickets is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: { ...baseContext.canonicalState, tickets: undefined },
    };
    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when all optional fields are undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        tickets: undefined,
        recentEvents: undefined,
        activeDecisions: undefined,
      },
      retrievedContext: {
        ...baseContext.retrievedContext,
        graphPaths: undefined,
        codeIntel: undefined,
      },
    };
    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should include ticket info when tickets are present', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        tickets: [
          {
            id: 'ticket-1',
            title: 'Fix auth bug',
            status: 'open',
            priority: 'high',
            assignedToUserId: null,
            assignedToAgentId: null,
            createdAt: new Date('2025-01-01'),
            updatedAt: new Date('2025-01-01'),
          },
        ],
      },
    };
    const result = adapter.formatContext(ctx);
    expect(result).toContain('Fix auth bug');
    expect(result).toContain('open');
    expect(result).toContain('high');
  });

  it('should include graph paths and code intel sections when present', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      retrievedContext: {
        ...baseContext.retrievedContext,
        graphPaths: [{ path: [], relation: 'depends-on', depth: 1 }],
        codeIntel: [
          {
            commitHash: 'abc123',
            changedFiles: [],
            impactedSymbols: [],
            impactedServices: [],
            impactedTickets: [],
            impactScore: 0,
          },
        ],
      },
    };
    const result = adapter.formatContext(ctx);
    expect(result).toContain('Entity Graph');
    expect(result).toContain('Code Intelligence');
  });

  it('should include meta line with intent, tokens, and latency', () => {
    const result = adapter.formatContext(baseContext);
    expect(result).toContain('diagnose');
    expect(result).toContain('100');
    expect(result).toContain('50ms');
  });
});
