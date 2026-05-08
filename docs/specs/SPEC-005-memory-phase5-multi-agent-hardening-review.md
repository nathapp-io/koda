# Code Review: SPEC-005 Memory Phase 5 Multi-Agent Hardening

Reviewed branch: `feat/memory-phase5-multi-agent-hardening` against `main`

Spec: [`SPEC-005-memory-phase5-multi-agent-hardening.md`](./SPEC-005-memory-phase5-multi-agent-hardening.md)

## Findings

### P1: CI policy gates are mostly fixture-only and can pass while real invariants are broken

The policy gate runner constructs `PolicyGateService` directly instead of bootstrapping the Nest app, Prisma, or the real memory/retrieval services:

- `apps/api/scripts/policy-gates-runner.ts:129`

Because no real services are injected, several gates fall back to in-memory fixture behavior:

- `apps/api/src/policy/policy-gate.service.ts:462`
- `apps/api/src/policy/policy-gate.service.ts:577`

This means the CI job can pass even if the real retriever leaks cross-project data, omits provenance, or exceeds token budget. SPEC-005 requires policy gates to run against isolated test data using a real database, so this is a hardening gap rather than just weak test coverage.

### P1: `tokenBudget` is not enforced against the actual returned response

`ContextBuilderService` enforces the budget only against `retrievedContext`:

- `apps/api/src/context/context-builder.service.ts:139`
- `apps/api/src/context/context-builder.service.ts:271`

But `meta.tokensUsed` later adds both `canonicalState` and `retrievedContext`:

- `apps/api/src/context/context-builder.service.ts:152`

A large canonical snapshot can push `tokensUsed` above `tokenBudget` with no truncation path. This violates the Phase 5 budget contract and will make `TokenBudgetGate` unreliable once it is connected to real data.

### P2: The required `copilot` adapter is missing

SPEC-005 lists `claude-code`, `nax`, and `copilot` in the adapter set. The implementation only recognizes/registers `claude-code` and `nax`:

- `apps/api/src/agents/agent-registry.service.ts:22`
- `apps/api/src/agents/agents.module.ts:25`

As implemented, `getAdapter('copilot')` fails.

### P2: `repoRefs` do not make code intelligence relevant by default

The spec says `includeCodeIntel` defaults to `false` unless `repoRefs` or changed files make code intelligence relevant. The implementation requires both `includeCodeIntel === true` and non-empty `repoRefs`:

- `apps/api/src/context/context-builder.service.ts:134`

Callers that pass `repoRefs` without explicitly setting `includeCodeIntel` receive no code intelligence.

## Verification

- Ran `bun run db:generate`
- Ran `bun run type-check` successfully after Prisma generation
- Ran `cd apps/api && bun run policy:gates -- --project=test-project`; it passed, which also confirmed the fixture-only gate concern above
