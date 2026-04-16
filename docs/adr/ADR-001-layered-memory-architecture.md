# ADR-001: Layered Memory Architecture for Koda

## Status

Proposed

## Date

2026-04-16

## Context

Koda is evolving from a ticket tracker with basic RAG capabilities into a system that coordinates humans and AI agents across tickets, code, and project knowledge.

Today, Koda already has:
- relational project and ticket data in Prisma/Postgres-compatible models
- a project-scoped knowledge base search path in the API
- graphify-powered code document ingestion into the knowledge base
- agent and VCS primitives that will need to consume richer shared context over time

However, the current implementation still has important limitations:
- no canonical event history for operational memory
- no durable semantic memory layer
- no unified context contract shared by all agents
- no hybrid retrieval pipeline combining lexical, vector, graph, and temporal signals
- no code-intelligence layer for commit-aware impact analysis
- derived knowledge-base content can be useful, but it is not authoritative truth

The memory phase specs define a multi-phase enhancement program to address those gaps:
- [20260416-plan-koda-memory-gap-analysis-v2.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/20260416-plan-koda-memory-gap-analysis-v2.md)
- [SPEC-0XX-memory-roadmap-overview.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-0XX-memory-roadmap-overview.md)
- [SPEC-000-memory-phase0-guardrails.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-000-memory-phase0-guardrails.md)
- [SPEC-001-memory-phase1-canonical-episodic.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-001-memory-phase1-canonical-episodic.md)
- [SPEC-002-memory-phase2-hybrid-retrieval.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-002-memory-phase2-hybrid-retrieval.md)
- [SPEC-003-memory-phase3-semantic-memory.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-003-memory-phase3-semantic-memory.md)
- [SPEC-004-memory-phase4-graph-code-intelligence.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-004-memory-phase4-graph-code-intelligence.md)
- [SPEC-005-memory-phase5-multi-agent-hardening.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-005-memory-phase5-multi-agent-hardening.md)

This ADR records the high-level architectural direction so future implementation work stays aligned even as the phase details evolve.

## Decision

Koda will adopt a layered memory architecture.

The architecture has five guiding decisions:

1. Canonical operational truth stays in relational data.
   - Project, ticket, agent, comment, label, and future event records remain the source of truth.
   - New episodic memory tables and event logs are canonical.
   - Derived memory stores must never become the authority for workflow or policy decisions.

2. Derived memory is allowed, but it is non-authoritative.
   - Retrieval indexes, semantic memory, entity graphs, and code-intelligence indexes may be built for speed, recall, and agent usefulness.
   - When canonical state and derived state disagree, canonical state wins.

3. Project isolation is a hard invariant.
   - Every memory read and write must remain scoped to a single project.
   - Public APIs should continue using project `slug` as the external identifier.
   - Internal services, storage, and joins may use `projectId` after controller-level resolution.

4. Shared context assembly becomes the standard agent contract.
   - Koda will move toward a single context-building path for agents instead of agent-specific retrieval behavior.
   - The long-term target is a common context contract that composes canonical state, episodic memory, semantic memory, retrieval results, and code/graph context.

5. The memory system is phased and incremental.
   - Koda will not attempt a single big-bang rewrite.
   - Guardrails and canonical event infrastructure come first.
   - More advanced retrieval, semantic memory, graph intelligence, and multi-agent hardening are layered on top.

## Scope

This ADR approves the direction, not every implementation detail.

In scope:
- adopting the layered memory model as the target architecture
- treating memory as a cross-cutting platform capability
- establishing the precedence of canonical over derived state
- using the phase specs as the implementation roadmap

Out of scope:
- final schema details for every phase
- exact ranking formulas, thresholds, or SLO values
- exact DTO and controller shapes for future APIs
- implementation sequencing within a phase

Those details belong in the phase specs and follow-up ADRs if a phase introduces an expensive-to-reverse decision.

## Architectural Principles

### Canonical over derived

Canonical stores are authoritative. Derived stores exist to improve retrieval quality, latency, and agent ergonomics.

Examples of derived stores in this program:
- lexical and vector retrieval indexes
- semantic memory items derived from events
- entity graphs
- symbol and code-intelligence indexes

These stores may be rebuilt, repaired, or discarded without redefining the source of truth.

### Event-driven synchronization

Derived stores should be synchronized from canonical writes through a durable event/outbox pattern rather than ad hoc side effects spread across services.

This allows:
- replay and recovery
- clearer failure handling
- better auditability
- incremental fan-out into future retrieval and memory components

### Agent-safe context

Agents should not assemble project truth by directly querying unrelated stores with custom prompts and heuristics. Over time, Koda should centralize context assembly behind a shared API/service boundary that enforces isolation, provenance, and budget limits consistently.

### Extend existing Koda conventions

The memory architecture should follow current platform conventions unless there is a deliberate decision to change them:
- public project-facing routes use `slug`
- internal service boundaries use `projectId`
- project-scoped VCS/webhook capabilities extend existing project-scoped surfaces
- repository scripts and docs use Bun-first command conventions

## Consequences

### Positive

- gives Koda a clear long-term architecture for agent context
- reduces the risk that RAG content is mistaken for workflow truth
- creates a path toward better multi-agent consistency
- supports future code-intelligence and impact-analysis features without making them the source of truth
- makes memory work easier to stage across multiple PRs and milestones

### Costs and tradeoffs

- adds architectural complexity and more moving parts
- introduces canonical/derived synchronization work that must be operated carefully
- requires discipline to keep boundaries clean between relational truth and derived memory
- some short-term duplication is expected while older APIs coexist with newer memory layers

## Rejected Alternatives

### Keep the current KB/RAG approach as the only memory system

Rejected because it does not provide canonical event history, semantic memory governance, or a shared contract for multi-agent context.

### Make the vector/graph store the source of truth

Rejected because retrieval stores are optimized for recall and ranking, not authoritative workflow state, transactional integrity, or policy enforcement.

### Build all phases in one large rewrite

Rejected because the scope is too large, risk is high, and Koda already has live patterns that should be evolved incrementally.

## Follow-up ADR Guidance

Create narrower ADRs only when implementation reaches a decision that is expensive to reverse, such as:
- canonical event/outbox model
- hybrid retrieval contract
- semantic memory governance model
- graph/code-intelligence persistence model
- shared context contract for agents

Do not create ADRs for routine story decomposition, script naming tweaks, or minor spec cleanup.

## References

- [architecture.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/architecture.md)
- [20260416-plan-koda-memory-gap-analysis-v2.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/20260416-plan-koda-memory-gap-analysis-v2.md)
- [SPEC-0XX-memory-roadmap-overview.md](/home/williamkhoo/Desktop/projects/nathapp/koda/docs/specs/SPEC-0XX-memory-roadmap-overview.md)
