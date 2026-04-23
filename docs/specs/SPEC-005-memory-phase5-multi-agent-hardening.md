# SPEC: Memory Phase 5 — Multi-Agent Consistency & Hardening

## Summary

Make Koda's memory behavior consistent across all agents and hardened for production. Enforce a shared context retrieval contract, add CI policy gates for isolation/truth/provenance, implement token budgets, and build an SLO dashboard.

## Phase Boundary

Phase 5 is the integration and hardening phase. It must not invent new memory stores or new ranking algorithms. It composes the services delivered by Phases 1-4 behind one contract and proves that contract is safe enough for multiple agents.

Phase 5 deliverables are:
- one shared `getProjectContext()` path for all agent adapters
- policy gates that fail CI when memory invariants break
- token-budget enforcement with deterministic truncation
- persisted operational metrics for latency, provenance coverage, stale hits, and leakage incidents

Phase 5 does not require a full web UI dashboard. A JSON admin endpoint and CI artifacts are sufficient unless a later web spec adds UI work.

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
  includeCodeIntel?: boolean;  // default false unless repoRefs/changedFiles make it relevant
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

**Consistency rule:** For the same `(projectId, actorId, intent, query, ticketIds, repoRefs, timeWindow, includeCodeIntel, includeGraph, tokenBudget)` input and unchanged underlying data, all adapters must receive the same structured `GetProjectContextResponse`. Adapters may only change formatting, not retrieval behavior.

**Token estimation:** Use the repo's existing tokenizer if one exists. If no tokenizer exists, use a deterministic approximation (`ceil(characters / 4)`) and store that choice in one helper so all gates use the same estimate.

**Empty-query behavior:** If `query` is absent or blank, `ContextBuilderService` still returns canonical state and semantic memory, but `retrievedContext.documents.results` is an empty array and no hybrid search call is made.

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
| `GraphifyEnabledGate` | Code results are hidden when `Project.graphifyEnabled=false` | Any `source='code'` result leaks |
| `TokenBudgetGate` | `getProjectContext` with `tokenBudget=1000` returns under 1000 tokens | Overshoot > 5% |

**Implementation:** Policy gates run against a test project in CI using a real (not mocked) database. Each gate produces a JSON report consumed by the CI pipeline.

**Gate fixture setup:** Policy gates must create or load their own isolated test data. They must not depend on developer-local projects, external services, or production data. Test project identifiers should be deterministic inside the test database.

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
  async recordQueryMetric(metric: MemoryQueryMetricInput): Promise<void>
  async recordStaleHit(projectId: string, docId: string): Promise<void>
}

interface MemoryQueryMetricInput {
  projectId: string;
  intent: string;
  latencyMs: number;
  tokensUsed?: number;
  hadProvenance: boolean;
  staleHitCount: number;
  resultCount: number;
  leakageIncidentCount?: number;
}

interface SloMetrics {
  retrievalLatency!: {
    p50: number;
    p95: number;
    p99: number;
    sampleCount: number;
  };
  staleHitRate!: number;       // stale result hits / total result hits
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

**Metric persistence:** Metrics may be stored in a single append-only table such as `MemoryQueryMetric`:

```sql
model MemoryQueryMetric {
  id                    String   @id @default(cuid())
  projectId              String
  intent                 String
  latencyMs              Int
  tokensUsed             Int?
  hadProvenance          Boolean
  staleHitCount          Int      @default(0)
  resultCount            Int      @default(0)
  leakageIncidentCount   Int      @default(0)
  createdAt              DateTime @default(now())

  @@index([projectId, createdAt])
  @@index([createdAt])
}
```

The exact model name can differ, but the persisted fields must be sufficient to compute every `SloMetrics` field without reading raw search responses.

`memoryGrowthRate` is computed from `MemoryItem.createdAt`, not from `MemoryQueryMetric`.

### Context Files (optional)
- `apps/api/src/context/context-builder.service.ts` — new file
- `apps/api/src/policy/policy-gate.service.ts` — new file
- `apps/api/src/agents/agent-registry.service.ts` — new file
- `apps/api/src/monitoring/slo-dashboard.service.ts` — new file

---

## Stories

### US-001: ContextBuilderService — Shared Retrieval Contract
**Size:** Complex | **AC count:** 12 | **Files:** 5 | **Depends on:** SPEC-001/US-005, SPEC-002/US-001, SPEC-003/US-005, SPEC-004/US-006

**ACs:**
- `getProjectContext(query)` returns all four top-level blocks: `canonicalState`, `retrievedContext`, `provenance`, `meta`
- `canonicalState.recentEvents` is ordered by `createdAt DESC` and limited to 20 events
- `retrievedContext.semanticMemory` is ordered by `confidence DESC` and limited to 10 items
- `retrievedContext.documents` calls `HybridRetrieverService.search()` internally
- If `query` is blank or absent, `retrievedContext.documents.results` is empty and `HybridRetrieverService.search()` is not called
- `getProjectContext` with `intent='plan'` excludes `canonicalState.recentEvents` (performance skip)
- `tokenBudget` truncation removes lower-priority blocks first and never removes `canonicalState.tickets` or `canonicalState.activeDecisions`; `canonicalState.recentEvents` may be omitted for `intent='plan'`
- `meta.latencyMs` measures wall-clock time from entry to return (excluding network)
- Calling `getProjectContext` with a non-existent `projectId` throws `ProjectNotFoundError` (`code: 'PROJECT_NOT_FOUND'`)
- All errors thrown by `getProjectContext` are `KodaError` subclasses and serialize to the `ErrorEnvelope` format defined in SPEC-001 §5
- `getProjectContext` is callable only by actors with role `admin`, `developer`, `agent`, or `viewer` on the target project
- Repeated calls with identical input and unchanged data produce the same result ordering across all agent adapters

### US-002: Policy Gates — Isolation + Provenance + Write Safety + GraphifyEnabled
**Size:** Medium | **AC count:** 11 | **Files:** 4 | **Depends on:** SPEC-000/US-002, SPEC-000/US-003, SPEC-002/US-006

**ACs:**
- `IsolationGate` runs 10 queries that should return 0 results for project-A, asserts all 10 return 0 results
- `IsolationGate` seeds project-A and project-B, then queries project-B-specific terms while scoped to project-A and asserts no project-B data is returned
- `ProvenanceGate` runs 20 fixture search queries with known matching results and asserts every non-empty response has `provenance.sources.length > 0`
- `WriteGate` runs `KodaDomainWriter` writes and asserts they succeed; direct repository writes in CI test mode throw a `KodaError` with `code='WRITE_GATE_VIOLATION'`
- `TruthConsistencyGate` picks 10 random canonical ticket IDs, queries both canonical store and derived store, asserts content matches
- `GraphifyEnabledGate` runs 10 queries on a project with `graphifyEnabled=false`, asserts zero results have `source='code'`
- `TokenBudgetGate` calls `getProjectContext` with `tokenBudget=1000`, measures `meta.tokensUsed`, asserts `tokensUsed <= 1050` (5% tolerance)
- All gates are runnable via `bun run policy:gates -- --project=X`
- When any gate fails, `PolicyGateResult.blockedReason` is non-null and describes the failure
- Gate results are written to `apps/api/test/policy-gates/results.json` for CI artifact capture
- Policy gates set up deterministic fixture data and do not read production, staging, or developer-local projects

### US-003: Agent Adapter Registry
**Size:** Medium | **AC count:** 7 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `AgentRegistryService.register()` stores the adapter and it is retrievable by `agentId`
- `AgentRegistryService.getAdapter('claude-code')` returns an adapter with `formatContext()` that formats `GetProjectContextResponse` as a Claude Code prompt fragment
- `AgentRegistryService.getAdapter('nax')` returns an adapter with `formatContext()` for nax prompt injection
- Calling `register()` twice with the same `agentId` replaces the existing adapter
- `KodaAgentAdapter.getContextForAgent(agentId, query)` calls `ContextBuilderService.getProjectContext()` and then `registry.getAdapter(agentId).formatContext()`
- The registry is seeded with adapters for `claude-code` and `nax` on app startup
- Adapters cannot call retrieval, memory, graph, or code-intel services directly; they only receive the already-built `GetProjectContextResponse`

### US-004: SLO Dashboard + Token Budgets
**Size:** Medium | **AC count:** 8 | **Files:** 3 | **Depends on:** US-001

**ACs:**
- `recordQueryMetric()` persists a query metric record (projectId, latencyMs, intent, tokensUsed, hadProvenance, staleHitCount, resultCount, timestamp)
- `getSloMetrics({ from, to })` computes p50/p95/p99 from persisted latency records in the time window
- `staleHitRate` is computed as `sum(staleHitCount) / sum(resultCount)` in the window, with `0` returned when `resultCount=0`
- `provenanceCoverage` is computed as `count(hadProvenance=true) / count(total queries)` in the window
- Stale hit counts are recorded when `HybridRetrieverService.search()` returns results whose `indexedAt` is more than 7 days old
- `leakageIncidents` is incremented by `IsolationGate` whenever a cross-project access is detected
- `GET /admin/slos?from=X&to=Y` returns the full `SloMetrics` object as JSON
- Metrics persist enough fields to compute all `SloMetrics` without reading raw context response bodies

### US-005: CI Pipeline Integration
**Size:** Simple | **AC count:** 4 | **Files:** 2 | **Depends on:** US-002, US-004

**ACs:**
- CI pipeline runs `bun run policy:gates -- --project=test-project` on every PR
- CI pipeline fails (exit code 1) when `PolicyGateResult.passed === false`
- `bun run policy:gates` outputs a summary table to stdout (PASS/FAIL per gate)
- SLO metrics are exported to a JSON artifact after each CI run
