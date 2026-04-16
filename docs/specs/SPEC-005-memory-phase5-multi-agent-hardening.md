# SPEC: Memory Phase 5 — Multi-Agent Consistency & Hardening

## Summary

Make Koda's memory behavior consistent across all agents and hardened for production. Enforce a shared context retrieval contract, add CI policy gates for isolation/truth/provenance, implement token budgets, and build an SLO dashboard.

## Motivation

Phase 1-4 delivered individual components. Phase 5 ensures they work together correctly regardless of which agent calls them. Without this, different agents get different answers to the same question. This is the integration and hardening phase.

## Design

### 1. Shared Context Retrieval Contract

A single canonical interface that all agents use — no agent-specific retrieval paths.

```ts
// apps/api/src/context/context-builder.service.ts
// CanonicalStateService is defined in SPEC-004 §6
class ContextBuilderService {
  constructor(
    private canonical: CanonicalStateService,
    private episodic: TimelineService,
    private semantic: MemoryService,
    private graph: EntityGraphService,
    private hybrid: HybridRetrieverService,
    private codeIntel: ImpactAnalysisService,
  ) {}

  async getProjectContext(query: GetProjectContextQuery): Promise<GetProjectContextResponse>
}

interface GetProjectContextQuery {
  projectId: string;
  actorId: string;
  intent: 'answer' | 'diagnose' | 'plan' | 'update' | 'search';
  query?: string;
  ticketIds?: string[];
  repoRefs?: string[];
  timeWindow?: { from?: Date; to?: Date };
  includeCodeIntel?: boolean;  // default true
  includeGraph?: boolean;       // default false (opt-in, expensive)
  tokenBudget?: number;          // max output tokens to spend on context (default 4000)
}

interface GetProjectContextResponse {
  projectId: string;
  canonicalState!: {
    tickets?: Ticket[];
    recentEvents?: TimelineEvent[];
    activeDecisions?: MemoryItem[];
  };
  retrievedContext!: {
    documents!: HybridSearchResult;
    semanticMemory!: MemoryItem[];
    graphPaths?: EntityPath[];  // only when includeGraph=true
    codeIntel?: ChangeImpactResult[];  // only when includeCodeIntel=true
  };
  provenance!: ResponseProvenance;
  meta!: {
    intent: string;
    tokensUsed: number;   // estimated
    retrievedAt: Date;
    latencyMs: number;
  };
}
```

**Token budget enforcement:** `ContextBuilderService` truncates the `retrievedContext` block to stay within `tokenBudget`. Priority order: `canonicalState` > `semanticMemory` > `documents` > `graphPaths` > `codeIntel`. Lower-priority blocks are truncated first.

**Adapter for Claude Code / nax:** A thin `KodaAgentAdapter` class that wraps `getProjectContext()` and formats the response for the agent's prompt template.

### 2. CI Policy Gates

Automated tests that run in CI and enforce invariants on every PR.

```ts
// apps/api/src/policy/policy-gate.service.ts
class PolicyGateService {
  // Called by CI before merge
  async runAllGates(projectId: string): Promise<PolicyGateResult>
}

interface PolicyGateResult {
  passed: boolean;
  gates!: GateResult[];
  blockedReason?: string;
}

interface GateResult {
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}
```

**Gates:**

| Gate | What it checks | Fails if |
|------|---------------|----------|
| `IsolationGate` | No cross-project data access in test queries | Any result from wrong project |
| `ProvenanceGate` | All search responses have `provenance.sources` populated | Any response missing provenance |
| `TruthConsistencyGate` | Canonical state matches derived store for 10 random queries | Discrepancy > 0 |
| `WriteGate` | All write paths go through `KodaDomainWriter` | Direct repository write detected |
| `TokenBudgetGate` | `getProjectContext` with `tokenBudget=1000` returns under 1000 tokens | Overshoot > 5% |

**Implementation:** Policy gates run against a test project in CI using a real (not mocked) database. Each gate produces a JSON report consumed by the CI pipeline.

### 3. Agent Adapter Registry

```ts
// apps/api/src/agents/agent-registry.service.ts
class AgentRegistryService {
  register(agentId: string, adapter: AgentAdapter): void
  getAdapter(agentId: string): AgentAdapter
  listAgents(): AgentInfo[]
}

interface AgentAdapter {
  agentId: string;
  name: string;
  capabilities: AgentCapability[];
  formatContext(ctx: GetProjectContextResponse): string  // prompt fragment
}

type AgentCapability = 'ticket_ops' | 'code_search' | 'code_write' | 'planning' | 'incident_diagnosis'
```

**Adapter list:**
- `claude-code` — format for Claude Code prompt injection
- `nax` — format for nax self-development agent
- `copilot` — format for GitHub Copilot Chat

### 4. SLO Dashboard

```ts
// apps/api/src/monitoring/slo-dashboard.service.ts
class SloDashboardService {
  async getSloMetrics(timeWindow: { from: Date; to: Date }): Promise<SloMetrics>
  async recordQueryLatency(projectId: string, latencyMs: number, intent: string): Promise<void>
  async recordStaleHit(projectId: string, docId: string): Promise<void>
}

interface SloMetrics {
  retrievalLatency!: {
    p50: number;
    p95: number;
    p99: number;
    sampleCount: number;
  };
  staleHitRate!: number;       // staleHits / totalQueries
  provenanceCoverage!: number;  // queriesWithProvenance / totalQueries
  leakageIncidents!: number;    // cross-project access attempts in window
  memoryGrowthRate!: number;    // memory items added per day (7-day avg)
}
```

**SLO targets:**
- `retrievalLatency.p95 < 500ms`
- `staleHitRate < 0.05` (5%)
- `provenanceCoverage >= 0.99` (99%)
- `leakageIncidents == 0`

### Context Files (optional)
- `apps/api/src/context/context-builder.service.ts` — new file
- `apps/api/src/policy/policy-gate.service.ts` — new file
- `apps/api/src/agents/agent-registry.service.ts` — new file
- `apps/api/src/monitoring/slo-dashboard.service.ts` — new file

---

## Stories

### US-001: ContextBuilderService — Shared Retrieval Contract
**Size:** Complex | **AC count:** 10 | **Files:** 5 | **Depends on:** SPEC-001/US-005, SPEC-002/US-001, SPEC-003/US-005, SPEC-004/US-001

**ACs:**
- `getProjectContext(query)` returns all four top-level blocks: `canonicalState`, `retrievedContext`, `provenance`, `meta`
- `canonicalState.recentEvents` is ordered by `createdAt DESC` and limited to 20 events
- `retrievedContext.semanticMemory` is ordered by `confidence DESC` and limited to 10 items
- `retrievedContext.documents` calls `HybridRetrieverService.search()` internally
- `getProjectContext` with `intent='plan'` excludes `canonicalState.recentEvents` (performance skip)
- `tokenBudget` truncation removes lower-priority blocks first, never `canonicalState`
- `meta.latencyMs` measures wall-clock time from entry to return (excluding network)
- Calling `getProjectContext` with a non-existent `projectId` throws `ProjectNotFoundError` (`code: 'PROJECT_NOT_FOUND'`)
- All errors thrown by `getProjectContext` are `KodaError` subclasses and serialize to the `ErrorEnvelope` format defined in SPEC-001 §5
- `getProjectContext` is callable only by actors with role `admin`, `developer`, `agent`, or `viewer` on the target project

### US-002: Policy Gates — Isolation + Provenance + Write Safety + GraphifyEnabled
**Size:** Medium | **AC count:** 9 | **Files:** 4 | **Depends on:** SPEC-000/US-002, SPEC-000/US-003, SPEC-002/US-006

**ACs:**
- `IsolationGate` runs 10 queries that should return 0 results for project-A, asserts all 10 return 0 results
- `ProvenanceGate` runs 20 search queries and asserts every response has `provenance.sources.length > 0`
- `WriteGate` runs `KodaDomainWriter` writes and asserts they succeed; direct repository writes in CI test mode throw a `KodaError` with `code='WRITE_GATE_VIOLATION'`
- `TruthConsistencyGate` picks 10 random canonical ticket IDs, queries both canonical store and derived store, asserts content matches
- `GraphifyEnabledGate` runs 10 queries on a project with `graphifyEnabled=false`, asserts zero results have `source='code'`
- `TokenBudgetGate` calls `getProjectContext` with `tokenBudget=1000`, measures `meta.tokensUsed`, asserts `tokensUsed <= 1050` (5% tolerance)
- All gates are runnable via `npm run policy:gates -- --projectId=X`
- When any gate fails, `PolicyGateResult.blockedReason` is non-null and describes the failure
- Gate results are written to `apps/api/test/policy-gates/results.json` for CI artifact capture

### US-003: Agent Adapter Registry
**Size:** Medium | **AC count:** 6 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `AgentRegistryService.register()` stores the adapter and it is retrievable by `agentId`
- `AgentRegistryService.getAdapter('claude-code')` returns an adapter with `formatContext()` that formats `GetProjectContextResponse` as a Claude Code prompt fragment
- `AgentRegistryService.getAdapter('nax')` returns an adapter with `formatContext()` for nax prompt injection
- Calling `register()` twice with the same `agentId` replaces the existing adapter
- `KodaAgentAdapter.getContextForAgent(agentId, query)` calls `ContextBuilderService.getProjectContext()` and then `registry.getAdapter(agentId).formatContext()`
- The registry is seeded with adapters for `claude-code` and `nax` on app startup

### US-004: SLO Dashboard + Token Budgets
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `recordQueryLatency()` persists a query latency record (projectId, latencyMs, intent, timestamp)
- `getSloMetrics({ from, to })` computes p50/p95/p99 from persisted latency records in the time window
- `staleHitRate` is computed as `count(status='stale') / count(total)` in the window
- `provenanceCoverage` is computed as `count(provenance populated) / count(total queries)` in the window
- `recordStaleHit()` is called by `HybridRetrieverService.search()` when a result's `indexedAt` is more than 7 days old
- `leakageIncidents` is incremented by `IsolationGate` whenever a cross-project access is detected
- `GET /admin/slos?from=X&to=Y` returns the full `SloMetrics` object as JSON

### US-005: CI Pipeline Integration
**Size:** Simple | **AC count:** 4 | **Files:** 2 | **Depends on:** US-002, US-004

**ACs:**
- CI pipeline runs `npm run policy:gates -- --projectId=test-project` on every PR
- CI pipeline fails (exit code 1) when `PolicyGateResult.passed === false`
- `npm run policy:gates` outputs a summary table to stdout (PASS/FAIL per gate)
- SLO metrics are exported to a JSON artifact after each CI run
