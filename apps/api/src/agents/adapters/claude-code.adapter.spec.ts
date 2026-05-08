import { ClaudeCodeAdapter } from './claude-code.adapter';
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

describe('ClaudeCodeAdapter formatCanonicalState undefined guards', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  // Bug: formatCanonicalState accesses recentEvents.length without
  // guarding against undefined. canonicalState.recentEvents is optional
  // (CanonicalEvent[] | undefined). When undefined is passed, it should
  // NOT throw — the spec says recentEvents is optional and the adapter
  // must handle undefined gracefully.
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

  // Same issue at line 54 for activeDecisions
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

  // Both undefined simultaneously — both bugs can trigger at once
  it('should not throw when both recentEvents and activeDecisions are undefined', () => {
    const ctx: GetProjectContextResponse = {
      ...baseContext,
      canonicalState: {
        ...baseContext.canonicalState,
        recentEvents: undefined,
        activeDecisions: undefined,
      },
    };

    expect(() => adapter.formatContext(ctx)).not.toThrow();
  });

  // The formatted output should still be valid when optional fields are missing
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
    expect(result).toContain('<project-context>');
    expect(result).toContain('</project-context>');
    expect(result).toContain('Canonical State');
  });
});
