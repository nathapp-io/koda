## Phase 0 Carry-Forward

### Established Invariants [all]
- `projectId` is a hard isolation boundary. Every memory read and write must stay scoped to one valid Koda project.
- Canonical truth comes first. Derived stores are downstream projections, not the source of truth.
- Agent-initiated writes should go through `KodaDomainWriter`, not directly to repositories or retrieval services.
- Provenance must be preserved on retrieval responses so downstream policy gates can verify source and project correctness.
- Derived-store failures should not invalidate canonical writes. Retry and recovery belong in the outbox path.

### Current Foundations [all]
- `RagService.validateProjectId()` already enforces non-empty, valid, existing, non-deleted project IDs.
- `KodaDomainWriter` already exists and handles ticket events, agent actions, document indexing, and graphify import entrypoints.
- `OutboxEvent` persistence exists with retry and dead-letter states.
- KB search responses already include item-level and response-level provenance.
- Current retrieval is still vector plus FTS fusion, not the planned hybrid retrieval engine.

### Migration Anchors [implementer, reviewer]
- Expand existing `TicketEvent` and `AgentEvent` models rather than replacing them from scratch.
- Add `DecisionEvent` as the missing canonical event type for Phase 1.
- Treat `OutboxService` as the fan-out seam: Phase 1 should add real handler dispatch there.
- Treat `KodaDomainWriter` as the write-gate seam: Phase 1 should consolidate more write paths behind it.
- Treat current KB provenance DTOs as the starting point for broader response provenance contracts.

### Known Gaps [all]
- Write-gate rollout is incomplete; some code paths still call `RagService` directly.
- `OutboxService.processEvent()` is still a stub, so persistent queueing exists without real downstream fan-out.
- `KodaDomainWriter.importGraphify()` does not yet emit a canonical graphify event or enqueue a `graphify_import` outbox event.
- Current event payloads are stored as stringified JSON and are still simpler than the richer Phase 1 canonical schema.
- Error handling still leans on current Nest app exceptions, not the standardized Phase 1 `KodaError` envelope.
- Current graphify import path is full refresh for `code` content, not incremental diff.

### Phase 1 Build Order [implementer]
- First lock the canonical event schema: `TicketEvent`, `AgentEvent`, `DecisionEvent`, `OutboxEvent`.
- Then add repository and service seams for canonical event writes and timeline reads.
- Then implement real outbox fan-out with ordered processing semantics.
- Then move remaining direct write paths behind `KodaDomainWriter`.
- Only after fan-out is real should later extraction and index rebuild dependencies rely on outbox events.

### Do Not Assume [all]
- Do not assume write-gate adoption is complete.
- Do not assume outbox events are actually being dispatched to handlers yet.
- Do not assume current event tables already satisfy the full Phase 1 spec.
- Do not assume current retrieval contracts match the future Phase 2 hybrid retriever.
- Do not let derived indexes become the system of record.

### Review Checklist For Phase 1 [reviewer]
- New memory APIs enforce `projectId` isolation end to end.
- Canonical writes succeed independently of derived-store failures.
- New write paths route through `KodaDomainWriter`.
- Outbox events are durable, retryable, and auditable.
- Timeline and memory reads preserve provenance and never leak cross-project data.
