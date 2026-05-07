# Test Suite Summary — getChangeImpact API (Phase 4)

## Overview

Comprehensive failing test suite for the **getChangeImpact API** feature. All tests follow the RED phase of TDD — they fail initially because the feature is not yet implemented.

## Test Files Created

### 1. E2E Tests (14 tests)
**File:** `test/e2e/api-endpoint/endpoint.e2e.spec.ts`

Added to existing endpoint test file under "Code Intelligence — Change Impact Analysis" section:

- **AC1:** Returns ChangeImpactResult with schema fields (commitHash, changedFiles, impactedSymbols, impactedServices, impactedTickets, impactScore)
- **AC2:** impactedSymbols contains symbols matching changedFiles
- **AC3:** impactedServices linked to impacted symbols
- **AC4:** impactedTickets linked to impacted services
- **AC5:** impactScore between 0-100, computed with weighted formula
- **AC5b:** impactScore handles zero denominators gracefully
- **AC6:** Provenance included when ticketId provided
- **AC6b:** Provenance omitted when ticketId not provided
- **AC7:** Response completes under 5 seconds for 50 changed files
- **AC8:** 403 when user lacks READ permission for CodeIntel
- **AC8b:** 401 when missing authentication
- **Error cases:** 404 for nonexistent project, 400 for missing parameters
- **Agent access:** 200 with agent API key

### 2. Integration Tests — Service Layer
**File:** `test/integration/code-intel/impact-analysis.service.integration.spec.ts`

Service integration tests with real dependencies:

- **AC1:** Schema validation (all required fields present and correct types)
- **AC2:** Symbol filtering by changed files
- **AC3:** Service linking through Symbol.file → GraphNode.sourceFile
- **AC4:** Ticket collection linked to services
- **AC5:** Impact score calculation
  - Score between 0-100
  - Zero denominator guards (no NaN/Infinity)
  - Formula verification
- **AC6:** Provenance metadata
  - Included when ticketId provided
  - Excluded when ticketId not provided

### 3. Unit Tests — Service Logic
**File:** `test/unit/code-intel/impact-analysis.service.spec.ts`

Unit tests for core service logic with mocked dependencies:

**Symbol Filtering (3 tests):**
- Filter symbols by changed files
- Empty symbols array for unmatched files
- Symbol metadata validation (id, name, kind, file)

**Service Linking (3 tests):**
- Identify services linked to impacted symbols
- Link services through Symbol.file → GraphNode.sourceFile
- Handle EntityNode.sourceId mapping

**Ticket Collection (3 tests):**
- Identify tickets linked to impacted services
- Empty tickets array when no services impacted
- Ticket metadata validation (status, priority, type)

**Impact Score Calculation (5 tests):**
- Score between 0 and 100
- Weighted formula application (0.3 symbols + 0.3 services + 0.2 tickets + 0.2 incidents)
- Division by zero protection
- Zero impact returns 0 score
- Linked incidents influence score

**Provenance Metadata (3 tests):**
- Include provenance when ticketId provided
- Exclude provenance when ticketId not provided
- Sources list validation

**Query Parameters (3 tests):**
- Accept changedFiles as array
- Preserve original changedFiles in result
- Preserve commitHash in result

### 4. Unit Tests — Controller
**File:** `test/unit/code-intel/codeintel.controller.spec.ts`

Controller layer tests:

**Route Definition (1 test):**
- GET /projects/:slug/codeintel/impact endpoint exists

**Parameter Validation (5 tests):**
- Accept repoId, commitHash, changedFiles
- Accept optional ticketId
- Require repoId
- Require commitHash
- Require changedFiles
- Parse changedFiles from comma-separated string

**Permission Gating (4 tests):**
- @RequiredPermission([READ, "CodeIntel"]) decorator
- ADMIN users can access
- All agents can access
- Non-permitted users get 403

**Response Formatting (3 tests):**
- JsonResponse.Ok wrapper
- All required fields in response
- Provenance included/excluded based on ticketId

**Project Slug Resolution (2 tests):**
- Resolve project by slug
- 404 for nonexistent project

**Principal Injection (2 tests):**
- @Principal() injection
- Principal available for permission checks

### 5. Integration Tests — Module
**File:** `test/integration/code-intel/codeintel.module.integration.spec.ts`

Module integration tests:

**Module Structure (3 tests):**
- SymbolStore provided
- EntityGraphService provided
- GraphStoreService provided

**Dependency Injection (4 tests):**
- SymbolStore with PrismaService and TransactionManager
- EntityGraphService with entity store and optional Prisma
- GraphStoreService with PrismaService
- TRANSACTION_MANAGER token availability

**Service Availability (3 tests):**
- SymbolStore.findBySymbolId method
- EntityGraphService.rebuildGraph method
- GraphStoreService.getStoredGraph method

**Integration Scenarios (2 tests):**
- Service composition for getChangeImpact
- Transaction manager usage across services

**Module Registration (3 tests):**
- Static module registration pattern
- Token provision for entity store
- Optional dependency support (Prisma)

## Test Coverage by Acceptance Criteria

| AC | Criterion | Test Coverage |
|---|-----------|---|
| 1 | Schema with all fields | E2E + Integration + Unit (Service) |
| 2 | impactedSymbols matches changedFiles | E2E + Integration + Unit (3 tests) |
| 3 | impactedServices linked to symbols | E2E + Integration + Unit (3 tests) |
| 4 | impactedTickets linked to services | E2E + Integration + Unit (3 tests) |
| 5 | impactScore 0-100 with formula | E2E + Integration + Unit (5 tests) |
| 6 | Provenance with ticketId | E2E + Integration + Unit (3 tests) |
| 7 | <5 second response time | E2E (performance test) |
| 8 | Permission gating (READ, CodeIntel) | E2E + Controller (4 tests) |

## Test Statistics

- **Total test files created:** 5
- **Total test suites:** 15+
- **Total test cases:** 60+
- **E2E tests:** 14
- **Integration tests:** 25+
- **Unit tests:** 21+

## Running Tests

### Run all new tests:
```bash
# E2E tests
DATABASE_URL=file:./koda-test.db npx jest test/e2e/api-endpoint/endpoint.e2e.spec.ts

# Integration tests
DATABASE_URL=file:./koda-test.db npx jest test/integration/code-intel/

# Unit tests
npx jest test/unit/code-intel/
```

### Run specific test file:
```bash
npx jest test/unit/code-intel/impact-analysis.service.spec.ts
npx jest test/unit/code-intel/codeintel.controller.spec.ts
DATABASE_URL=file:./koda-test.db npx jest test/integration/code-intel/impact-analysis.service.integration.spec.ts
```

## Test Philosophy

All tests follow **RED → GREEN → REFACTOR** TDD workflow:

1. **RED**: Tests fail because `ImpactAnalysisService.getChangeImpact()` is not implemented
2. **GREEN**: Implementer writes minimal code to make tests pass
3. **REFACTOR**: Code is cleaned up while maintaining test coverage

## Key Testing Patterns

### Hermetic Tests
- All external dependencies mocked (SymbolStore, EntityGraphService, GraphStoreService)
- No network calls, no real database I/O outside integration tests
- In-memory mocks for entity store and transaction manager

### Permission Testing
- Guard rails for 403 (non-permitted users)
- Guard rails for 401 (unauthenticated)
- Support for ADMIN, DEVELOPER, and agent access

### Response Validation
- All fields present and correct types
- JsonResponse.Ok wrapping with envelope pattern
- Provenance metadata validation

### Error Handling
- Zero denominator protection (no NaN/Infinity)
- Missing parameter validation
- Project not found (404)
- Invalid transitions (400)

## Next Steps for Implementation

1. Create `ImpactAnalysisService` class in `src/code-intel/impact-analysis.service.ts`
2. Create `CodeIntelController` class in `src/code-intel/codeintel.controller.ts`
3. Create `CodeIntelModule` to wire services and controller
4. Implement impact score formula with weighted components
5. Implement symbol filtering and service linking logic
6. Implement provenance metadata generation
7. Register module in `AppModule`
8. Run tests to verify all pass

## Notes

- Tests use existing services: SymbolStore, EntityGraphService, GraphStoreService
- Impact score formula uses 0.3 symbols + 0.3 services + 0.2 tickets + 0.2 incidents
- Endpoint is gated with @RequiredPermission([KodaAction.READ, 'CodeIntel'])
- Provenance is optional and only included when ticketId is provided
- All tests are isolated and can run independently
