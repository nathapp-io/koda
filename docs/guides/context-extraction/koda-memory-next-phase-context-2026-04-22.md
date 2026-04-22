# Koda Memory Next-Phase Context Pack

Date: 2026-04-22
Source inputs:
- `docs/adr/ADR-010-context-engine.md`
- `koda/docs/specs/SPEC-000..005-memory-*`
- `koda/apps/api` implementation snapshot

## Why this pack exists

This document extracts the context that is most useful before starting Koda memory Phase 1 and later phases. It is meant to be short enough to hand to an agent, but grounded enough that it reflects what Phase 0 actually shipped.

## Executive summary

Koda Phase 0 established the right safety direction:
- `projectId` is now treated as a mandatory isolation key in the RAG layer.
- a `KodaDomainWriter` exists and writes canonical events before derived follow-up work.
- an `OutboxEvent` persistence model exists and supports retry/dead-letter semantics.
- KB search responses already include provenance.

The main thing to preserve for Phase 1 is this contract:
- canonical operational truth must live in durable event tables first
- derived stores are downstream, replayable, and allowed to fail independently
- all memory reads and writes remain project-scoped

The main thing not to assume yet:
- write-gate rollout is not complete across all write paths
- the outbox processor is not yet dispatching real handlers
- current event schemas do not yet match the richer Phase 1 spec
- retrieval is still vector/FTS fusion, not the Phase 2 hybrid retriever

## What Phase 0 appears to have shipped

### 1. Project isolation is enforced in the RAG core

`RagService.validateProjectId()` now rejects:
- missing project IDs
- malformed non-CUID IDs
- non-existent or deleted projects

Why this matters:
- later memory layers can safely assume `projectId` is a hard partition key
- retrieval and indexing already have a project-scoped seam to build on

Implementation anchors:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.service.ts:207`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.service.ts:266`

### 2. A canonical write gate exists

`KodaDomainWriter` currently handles:
- `writeTicketEvent()`
- `writeAgentAction()`
- `indexDocument()`
- `importGraphify()`

Useful invariant:
- canonical write first
- derived follow-up second
- outbox enqueue is fire-and-forget and non-blocking

Implementation anchors:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/koda-domain-writer/koda-domain-writer.service.ts:17`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/koda-domain-writer/koda-domain-writer.service.ts:48`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/koda-domain-writer/koda-domain-writer.service.ts:131`

### 3. Provenance is already part of KB reads

The KB DTOs already include:
- item-level provenance: `indexedAt`, `sourceProjectId`
- response-level provenance: `retrievedAt`, unique `sources`

This is a strong foundation for later policy gates and context-builder responses.

Implementation anchors:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/dto/kb-result.dto.ts:6`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/dto/kb-result.dto.ts:48`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.service.ts:500`

### 4. Durable outbox persistence exists, but fan-out is still a stub

The outbox supports:
- persistent `pending/processing/completed/dead_letter`
- attempts counting
- stale-processing requeue
- claim-before-process pattern

But `processEvent()` is still a placeholder, so Phase 1 should treat the outbox as persistence-ready but not fan-out-complete.

Implementation anchors:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/outbox/outbox.service.ts:35`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/outbox/outbox.service.ts:49`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/outbox/outbox.service.ts:162`

### 5. Event/outbox tables exist, but schema shape is Phase-0-simple

Current Prisma models include:
- `TicketEvent`
- `AgentEvent`
- `OutboxEvent`

Current gaps relative to Phase 1:
- no `DecisionEvent`
- event payloads are stored as stringified JSON, not typed `Json`
- event fields are simpler than the Phase 1 canonical schema

Implementation anchor:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/prisma/schema.prisma:257`

## Most important continuity from nax ADR-010

From the context-engine ADR, the most reusable design lesson for Koda is not the exact implementation. It is the shape of the memory substrate:

1. Separate canonical facts from derived retrieval material.
2. Prefer auditable manifests over opaque context blobs.
3. Support both push and pull context patterns.
4. Preserve provenance through every transformation.
5. Make degraded operation explicit rather than silent.

This maps well onto Koda:
- Phase 1 canonical event tables are analogous to canonical context sources.
- Phase 2+ retrieval layers are analogous to derived providers.
- provenance and policy gates are the equivalent of manifest/auditability.
- token budgets in Phase 5 mirror nax context budget packing.

## Phase-by-phase extraction for future work

### Phase 1: Canonical + episodic foundation

What Phase 1 should assume:
- `projectId` hard partitioning is already culturally established.
- write gateway and outbox concepts already exist and should be evolved, not replaced.

What Phase 1 should upgrade:
- normalize current `TicketEvent` and `AgentEvent` toward the richer spec
- add `DecisionEvent`
- replace placeholder outbox dispatch with a handler registry
- introduce timeline query services over canonical events
- standardize error types and actor resolution

Recommended implementation order:
1. lock the canonical event schema
2. add repository/service interfaces over event tables
3. wire real outbox dispatch
4. add timeline read APIs
5. only then expand derived handlers

### Phase 2: Hybrid retrieval

Useful current context:
- search already has a retrieval seam in `RagService.search()`
- current behavior is vector + FTS merge, so there is a natural compatibility bridge
- provenance is already present on results

What not to carry forward blindly:
- current search return shape does not include a four-way score breakdown
- current fusion logic is not intent-weighted
- graphify code documents are imported, but there is no entity-aware retrieval yet

### Phase 3: Semantic memory

Useful current context:
- ticket and agent events already provide canonical extraction inputs
- provenance culture is already present

Prerequisites that still need to exist first:
- stable event taxonomy
- outbox handlers that can feed extraction
- clear conflict rules and ownership model

### Phase 4: Graph + code intelligence

Useful current context:
- graphify import exists already
- code content is already being materialized into the KB

Current limitation to preserve in your mental model:
- `importGraphify()` still clears all `code` documents and reimports, so it is a full-refresh baseline, not incremental diff

Implementation anchor:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.service.ts:700`

### Phase 5: Multi-agent hardening

The most reusable lessons from current state:
- provenance is already a first-class read concern
- write gating already exists as a concept
- outbox retries/dead-letter are already introduced

What Phase 5 will need on top:
- one shared context-builder contract
- policy gates that assert isolation, provenance, truth consistency, and token budgets
- adapter formatting per agent, not retrieval differences per agent

## Concrete gaps worth carrying into Phase 1 planning

### Gap 1. Write gate rollout is incomplete

There are still direct write paths that bypass `KodaDomainWriter`, for example:
- direct RAG indexing in the KB controller
- direct graphify import in the KB controller
- ticket-close auto-indexing directly through `RagService`

Implementation anchors:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.controller.ts:47`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/rag/rag.controller.ts:118`
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/tickets/state-machine/ticket-transitions.service.ts:86`

Why it matters:
- policy gates in Phase 5 will be brittle unless write paths are consolidated earlier
- episodic/semantic extraction will miss events if bypasses remain

### Gap 2. Current `importGraphify()` does not produce a canonical write/outbox trail

`KodaDomainWriter.importGraphify()` delegates straight to `RagService.importGraphify()` and returns metadata, but it does not currently create a canonical event or enqueue a `graphify_import` outbox event.

Implementation anchor:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/koda-domain-writer/koda-domain-writer.service.ts:190`

Why it matters:
- Phase 2 lexical/entity rebuild hooks and Phase 4 graph/entity hooks want this event

### Gap 3. Outbox ordering is global pending FIFO, not explicitly per-project FIFO

The spec wants per-project ordered processing with cross-project concurrency. Current `processPending()` orders by `createdAt ASC` globally.

Implementation anchor:
- `/home/williamkhoo/Desktop/projects/nathapp/koda/apps/api/src/outbox/outbox.service.ts:52`

Why it matters:
- this is probably fine at low scale, but it is not yet the same contract as the spec

### Gap 4. Error model is not yet the Phase 1 standardized KodaError envelope

Current implementation still leans on Nest app exceptions. The Phase 1 spec introduces a much more explicit error contract.

Why it matters:
- if timeline/memory/context-builder APIs are built before error normalization, you will pay a refactor tax later

### Gap 5. Event payloads are string blobs today

This is acceptable for Phase 0 guardrails, but Phase 1+ extraction/querying will be easier if the canonical schema becomes more query-friendly.

## Suggested "next phase brief" for an agent

Use this as the compact brief for the next implementation pass:

1. Do not replace the current write-gate/outbox/provenance direction.
2. Treat existing `TicketEvent`, `AgentEvent`, and `OutboxEvent` as migration starting points, not final schemas.
3. Consolidate remaining direct write bypasses behind `KodaDomainWriter`.
4. Implement real outbox fan-out before depending on downstream semantic/entity rebuilds.
5. Keep `projectId` isolation and provenance mandatory in every new API.
6. Design Phase 1 so Phase 2-5 plug in as downstream consumers, not new sources of truth.

## Reusable extraction pattern from this exercise

The context extraction that worked best here was:
- read one architecture/ADR document first
- read the phase/spec sequence end to end
- inspect current implementation seams, not the whole repo
- identify invariants, gaps, migration anchors, and next-phase assumptions
- output one short handoff pack

That pattern is now captured as a reusable skill in:
- `skills/context-pack-extractor/`
