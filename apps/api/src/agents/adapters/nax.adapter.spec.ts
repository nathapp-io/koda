import { NaxAdapter } from './nax.adapter';
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

describe('NaxAdapter formatContext undefined guards', () => {
  let adapter: NaxAdapter;

  beforeEach(() => {
    adapter = new NaxAdapter();
  });

  // AC3: getAdapter('nax') returns an adapter with formatContext()
  // that formats GetProjectContextResponse for nax prompt injection.
  // The adapter must handle optional canonical fields gracefully.

  it('should produce nax delimiters', () => {
    const result = adapter.formatContext(baseContext);
    expect(result).toContain('=== KODA-PROJECT-CONTEXT ===');
    expect(result).toContain('=== END-CONTEXT ===');
  });

  it('should not throw when canonicalState.tickets is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        ...baseContext.canonicalState,
        tickets: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when canonicalState.recentEvents is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        ...baseContext.canonicalState,
        recentEvents: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when canonicalState.activeDecisions is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        ...baseContext.canonicalState,
        activeDecisions: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when all optional canonical fields are undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        tickets: undefined,
        recentEvents: undefined,
        activeDecisions: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when retrievedContext.graphPaths is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      retrievedContext: {
        ...baseContext.retrievedContext,
        graphPaths: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when retrievedContext.codeIntel is undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      retrievedContext: {
        ...baseContext.retrievedContext,
        codeIntel: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  it('should not throw when all optional retrievedContext fields are undefined', () => {
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

  it('should produce a valid context string when all optional fields are undefined', () => {
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

    const result = adapter.formatContext(ctx);

    expect(typeof result).toBe('string');
    expect(result).toContain('=== KODA-PROJECT-CONTEXT ===');
    expect(result).toContain('=== END-CONTEXT ===');
    expect(result).toContain('Intent:');
    expect(result).toContain('TICKETS: []');
  });

  // AC3 spec-correctness: the nax adapter should handle empty sections
  // consistently. If TICKETS: [] is output for empty/undefined tickets,
  // other sections should also have explicit markers when their data
  // is present but empty. The current implementation only marks empty
  // tickets, not events, decisions, documents, or memory.
  it('should include explicit markers for all sections when data is empty or missing', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        tickets: [],
        recentEvents: [],
        activeDecisions: [],
      },
      retrievedContext: {
        documents: { results: [], scores: [], retrievedAt: '2025-01-02T00:00:00Z' },
        semanticMemory: [],
        graphPaths: [],
        codeIntel: [],
      },
    };

    const result = adapter.formatContext(ctx);

    // All sections should have explicit markers when data is empty/missing
    expect(result).toContain('TICKETS: []');
    expect(result).toContain('EVENTS: []');
    expect(result).toContain('DECISIONS: []');
    expect(result).toContain('DOCS: []');
    expect(result).toContain('MEMORY: []');
  });
});
