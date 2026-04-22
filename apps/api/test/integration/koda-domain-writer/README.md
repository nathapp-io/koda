# KodaDomainWriter Integration Tests

## Overview

These integration tests define the expected behavior for the `KodaDomainWriter` service, which serves as the explicit write gateway for agent-initiated operations in Koda.

## Test Files

### `koda-domain-writer.integration.spec.ts`

Comprehensive integration tests covering all acceptance criteria for the feature. These tests verify:

1. **AC-1**: `writeTicketEvent()` writes to `ticket_events` table and returns `WriteResult` with `canonicalId`
2. **AC-2**: `writeAgentAction()` writes to `agent_events` table and returns `WriteResult` with `canonicalId`
3. **AC-3**: `indexDocument()` calls `RagService.indexDocument()` and returns `WriteResult` with `derivedIds`
4. **AC-4**: `importGraphify()` calls `RagService.importGraphify()` and returns `WriteResult`
5. **AC-5**: Every `WriteResult` includes fully populated `provenance` field with `actorId`, `projectId`, `action`, `timestamp`, `source`
6. **AC-6**: `writeTicketEvent()` with non-existent `projectId` throws `ForbiddenAppException`
7. **AC-7**: When `RagService.indexDocument()` fails during `indexDocument()`, `WriteResult.error` contains error message but canonical write is still committed
8. **AC-8**: `KodaDomainWriter` is injected into agent service flow, replacing direct repository calls

## Test Status

These tests are in the **RED phase** - they define expected behavior but the feature is not yet implemented.

## Running the Tests

```bash
# Run only these integration tests
cd apps/api
bun test test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts

# Run with verbose output
bun test --verbose test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts

# Run with coverage
bun test --coverage test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts
```

## Implementation Notes

When implementing the `KodaDomainWriter` service:

1. Create the service at `src/koda-domain-writer/koda-domain-writer.service.ts`
2. Implement all four public methods: `writeTicketEvent()`, `writeAgentAction()`, `indexDocument()`, `importGraphify()`
3. Use the DTOs and types defined in `src/koda-domain-writer/write-result.dto.ts`
4. Ensure all methods:
   - Validate that the project exists (throw `ForbiddenAppException` if not)
   - Return a `WriteResult` with complete `provenance` information
   - Handle errors gracefully (especially RAG service errors in `indexDocument()`)
5. Create the Prisma models for `ticket_events` and `agent_events` if they don't already exist
6. Wire the service into `AgentsService` to replace direct repository calls

## Acceptance Criteria Details

### AC-7: Graceful Error Handling

The `indexDocument()` method should:
- Attempt to call `RagService.indexDocument()`
- If it succeeds: return `WriteResult` with `derivedIds` and no `error` field
- If it fails: 
  - Still commit the canonical record (ticket event)
  - Return `WriteResult` with `canonicalId` and `error` containing the error message
  - Include both `canonicalId` and `error` in the result

This allows the system to persist provenance information even when optional indexing fails.

### AC-8: Agent Service Integration

The `KodaDomainWriter` should replace direct calls to repository methods in agent workflows:

**Before:**
```typescript
// In AgentsService
await this.prisma.client.ticketEvent.create({ data: {...} })
```

**After:**
```typescript
// In AgentsService
const result = await this.kodaDomainWriter.writeTicketEvent(...)
```

This ensures all agent-initiated writes go through the provenance-tracking gateway.

## Related Files

- DTOs/Types: `src/koda-domain-writer/write-result.dto.ts`
- Service Implementation (TODO): `src/koda-domain-writer/koda-domain-writer.service.ts`
- Unit Tests (TODO): `src/koda-domain-writer/koda-domain-writer.service.spec.ts`
- Integration Tests: `test/integration/koda-domain-writer/koda-domain-writer.integration.spec.ts`
