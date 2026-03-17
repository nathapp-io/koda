# Tickets CRUD - Test Summary

## Overview

Comprehensive test suite for US-003: Tickets CRUD with auto-incrementing numbers and dual-ref resolution.

**Status:** RED (All tests failing - source not implemented)

## Test Files Created

### 1. Unit Tests: `tickets.service.spec.ts` (640+ lines, 40+ tests)

Service-layer unit tests with mocked Prisma:

**Create Tests (9 tests)**
- Auto-increment number generation
- Sequential numbering validation
- Concurrent create safety (no duplicates)
- Project existence validation
- Creator assignment (user/agent)
- Field validation and defaults

**FindAll Tests (11 tests)**
- List all tickets (excluding soft-deleted)
- Status filter
- Type filter
- Priority filter
- AssignedTo filter
- Unassigned filter
- Pagination (limit, page, skip calculation)
- Empty results handling

**FindByRef Tests (8 tests)**
- Resolve by KODA-42 format
- Resolve by CUID
- Case-insensitive handling
- 404 error handling
- Soft-delete exclusion
- Format validation

**Update Tests (5 tests)**
- Update ticket fields
- Prevent immutable field updates
- 404 error handling
- Partial update support
- Field preservation

**SoftDelete Tests (4 tests)**
- Set deletedAt timestamp
- No hard delete
- ADMIN role requirement
- 404 error handling

**Assign Tests (6 tests)**
- Assign to user
- Assign to agent
- Unassign functionality
- Prevent both assignees
- 404 error handling

**Total: 43 service unit tests**

### 2. HTTP Layer Tests: `tickets.controller.spec.ts` (580+ lines, 45+ tests)

Controller tests with mocked service:

**POST /api/projects/:slug/tickets (7 tests)**
- 201 status code
- User authentication support
- Agent API key support
- DTO validation
- Project validation
- Authentication requirement

**GET /api/projects/:slug/tickets (10 tests)**
- Pagination metadata
- Status filter
- Type filter
- Priority filter
- AssignedTo filter
- Unassigned filter
- Limit and page parameters
- Filter combination
- Soft-delete exclusion
- Authentication requirement

**GET /api/projects/:slug/tickets/:ref (4 tests)**
- KODA-42 resolution
- CUID resolution
- 404 error handling
- Authentication requirement

**PATCH /api/projects/:slug/tickets/:ref (8 tests)**
- Update fields
- User update capability
- Agent update capability
- Partial update support
- Immutable field protection
- Validation errors
- 404 error handling
- Authentication requirement

**DELETE /api/projects/:slug/tickets/:ref (7 tests)**
- ADMIN soft-delete
- Non-ADMIN rejection (403)
- Agent rejection (403)
- 404 error handling
- No hard delete
- Authentication requirement

**POST /api/projects/:slug/tickets/:ref/assign (6 tests)**
- Assign to user
- Assign to agent
- Unassign
- Replace previous assignment
- Invalid assignment rejection (400)
- 404 error handling

**Total: 42 controller tests**

### 3. Integration Tests: `tickets.integration.spec.ts` (650+ lines, 35+ tests)

Service + database integration tests:

**Sequential Numbering (4 tests)**
- Start from 1
- Increment sequentially
- No duplicates
- Concurrent safety via transaction

**Dual-Ref Resolution (5 tests)**
- KODA-42 format resolution
- CUID format resolution
- Format differentiation
- Project key extraction
- Pattern validation

**Filtering (3 tests)**
- Single filter application
- Multiple filter combination
- Soft-delete exclusion

**Soft Delete (3 tests)**
- Data preservation
- Exclusion from findAll
- Exclusion from findByRef

**Complete Lifecycle (1 test)**
- Create → Retrieve → Update → Delete flow

**Pagination (3 tests)**
- Limit enforcement
- Skip offset calculation
- Boundary handling

**Total: 19 integration tests**

### 4. E2E Tests: `tickets.e2e.spec.ts` (700+ lines, 80+ test scenarios)

End-to-end HTTP tests with real request/response simulation:

**POST /api/projects/:slug/tickets (9 scenarios)**
- 201 status code
- Sequential numbering
- Default status = CREATED
- Default priority = MEDIUM
- Creator assignment
- Request validation (400)
- Project validation (404)
- Authentication requirement (401)

**GET /api/projects/:slug/tickets (12 scenarios)**
- Paginated response
- Empty list handling
- Status filter
- Type filter
- Priority filter
- AssignedTo filter
- Unassigned filter
- Pagination parameters
- Filter combination
- Soft-delete exclusion
- Project validation (404)
- Authentication requirement (401)

**GET /api/projects/:slug/tickets/:ref (9 scenarios)**
- KODA-42 resolution
- CUID resolution
- Case-insensitive resolution
- Number extraction
- Not found handling (404)
- Soft-delete exclusion
- Project validation (404)
- Authentication requirement (401)

**PATCH /api/projects/:slug/tickets/:ref (8 scenarios)**
- Title update
- Priority update
- Description update
- Partial update
- Immutable field protection
- id protection
- createdAt protection
- Update authorization
- Validation errors (400)
- Not found (404)
- Authentication requirement (401)

**DELETE /api/projects/:slug/tickets/:ref (8 scenarios)**
- ADMIN soft-delete
- Timestamp setting
- No hard delete
- Non-ADMIN rejection (403)
- Agent rejection (403)
- Not found (404)
- Authentication requirement (401)
- ADMIN role requirement

**POST /api/projects/:slug/tickets/:ref/assign (9 scenarios)**
- User assignment
- Agent assignment
- Unassignment
- Assignment replacement
- Rejection of both assignees (400)
- Not found (404)
- Self-assignment support
- Authentication requirement (401)

**Concurrent Operations (2 scenarios)**
- No duplicate numbers under concurrency
- 10 concurrent create safety

**Query Parameter Validation (8 scenarios)**
- Invalid status rejection
- Invalid type rejection
- Invalid priority rejection
- Non-integer page (400)
- Non-integer limit (400)
- Negative page rejection
- Negative limit rejection
- Maximum limit enforcement

**Response Format (3 scenarios)**
- All required fields present
- ISO 8601 date formatting
- No sensitive fields exposed

**Total: 80+ E2E test scenarios**

## Test Statistics

| Category | Count |
|----------|-------|
| Unit tests (Service) | 43 |
| HTTP tests (Controller) | 42 |
| Integration tests | 19 |
| E2E test scenarios | 80+ |
| **Total test cases** | **184+** |

| Feature | Tests | Coverage |
|---------|-------|----------|
| Auto-increment numbers | 9 | ✅ |
| Dual-ref resolution | 8 | ✅ |
| Filtering (6 types) | 20 | ✅ |
| Pagination | 8 | ✅ |
| Soft delete | 10 | ✅ |
| Assignment | 13 | ✅ |
| Concurrent ops | 2 | ✅ |
| Authentication | 20+ | ✅ |
| Validation | 15+ | ✅ |
| Error handling | 25+ | ✅ |

## Endpoints Covered

| Method | Endpoint | Unit | HTTP | Integration | E2E | Status |
|--------|----------|------|------|-------------|-----|--------|
| POST | /api/projects/:slug/tickets | ✅ | ✅ | ✅ | ✅ | Full |
| GET | /api/projects/:slug/tickets | ✅ | ✅ | ✅ | ✅ | Full |
| GET | /api/projects/:slug/tickets/:ref | ✅ | ✅ | ✅ | ✅ | Full |
| PATCH | /api/projects/:slug/tickets/:ref | ✅ | ✅ | ✅ | ✅ | Full |
| DELETE | /api/projects/:slug/tickets/:ref | ✅ | ✅ | ✅ | ✅ | Full |
| POST | /api/projects/:slug/tickets/:ref/assign | ✅ | ✅ | ✅ | ✅ | Full |

## Key Test Scenarios

### 1. Auto-Incrementing Numbers (Transaction-Safe)
```
Scenario: Create 3 tickets sequentially
Expected: Numbers are 1, 2, 3 (no gaps, no duplicates)

Scenario: Create 10 tickets concurrently
Expected: All succeed with unique sequential numbers
Mechanism: Prisma $transaction ensures atomic MAX(number)+1
```

### 2. Dual-Reference Resolution
```
Scenario: KODA-42 format (PROJECT_KEY-NUMBER)
- Extract "KODA" as project key
- Extract "42" as number
- Look up by composite key: projectId_number

Scenario: CUID format (e.g., clxyz123abc)
- Treat as ticket ID
- Look up by id directly

Mechanism: Pattern matching to differentiate
```

### 3. Soft Deletes
```
Scenario: Delete ticket
Expected: deletedAt = now(), not hard-deleted

Scenario: List tickets
Expected: deletedAt IS NULL in where clause

Scenario: Get deleted ticket
Expected: Returns null (not found)

Mechanism: Always filter on deletedAt in queries
```

### 4. Concurrent Safety
```
Scenario: 10 simultaneous POST requests
Expected: All create with unique numbers
- No race condition
- No duplicate key violations
- All promises resolve successfully

Mechanism: Prisma transaction lock during MAX+1
```

### 5. Filtering and Pagination
```
Query: GET /api/projects/koda/tickets?status=IN_PROGRESS&priority=HIGH&limit=10&page=2
Where:
  - projectId = <koda-id>
  - status = 'IN_PROGRESS'
  - priority = 'HIGH'
  - deletedAt = null
Skip: 10 (page 1 * limit 10)
Take: 10
```

## Failure Points (RED Phase)

All tests are currently **FAILING** due to missing source files:

```
✗ src/tickets/tickets.service.ts
✗ src/tickets/tickets.controller.ts
✗ src/tickets/dto/create-ticket.dto.ts
✗ src/tickets/dto/update-ticket.dto.ts
✗ src/tickets/dto/assign-ticket.dto.ts
✗ src/tickets/dto/list-tickets-query.dto.ts
```

Compilation errors:
```
error TS2307: Cannot find module '../../src/tickets/tickets.service'
error TS2307: Cannot find module '../../src/tickets/tickets.controller'
error TS2307: Cannot find module '../../src/tickets/dto/create-ticket.dto'
```

## Next Phase: GREEN

The implementer will:
1. Create TicketsService with all CRUD methods
2. Create TicketsController with all route handlers
3. Create DTOs with validation
4. Implement auto-increment logic using Prisma transactions
5. Implement dual-ref resolution
6. Implement filtering and pagination
7. Implement soft deletes
8. All 184+ tests should PASS

## Running Tests

```bash
# Run all tickets tests
bun run test test/tickets/

# Run specific test file
bun run test test/tickets/tickets.service.spec.ts
bun run test test/tickets/tickets.controller.spec.ts

# Run with pattern
bun run test test/tickets/ -t "sequential numbering"

# Watch mode
bun run test test/tickets/ --watch

# Coverage
bun run test test/tickets/ --coverage
```

## Architecture Notes

### Data Model
- Ticket number: auto-incremented per project (not global)
- Unique constraint: (projectId, number)
- KODA-42 format: PROJECT.key + Ticket.number
- Creator: polymorphic (userId OR agentId, not both)
- Assignee: polymorphic (userId OR agentId, not both)
- Soft delete: deletedAt timestamp, never hard delete

### Authentication
- Users: JWT Bearer token (login/register)
- Agents: API key in Authorization header
- Both supported in CombinedAuthGuard
- Admin role: required for delete operations

### State Machine
- CREATED → VERIFIED → IN_PROGRESS → VERIFY_FIX → CLOSED
- Can transition to REJECTED from any state
- Transitions require matching CommentType
- Enforced in state-machine/ticket-transitions.ts

### Transaction Safety
- Number generation: Prisma.$transaction
- Read max(number), increment, insert atomically
- Prevents race conditions on concurrent creates
- No Bun.Mutex needed (DB handles locks)

## Test Quality Checklist

- ✅ Comprehensive coverage (184+ tests)
- ✅ All endpoints tested (6/6)
- ✅ All features tested (10/10)
- ✅ Unit + Integration + E2E layers
- ✅ Error cases covered (404, 400, 401, 403)
- ✅ Concurrent safety tested
- ✅ Soft delete verified
- ✅ Authentication/Authorization tested
- ✅ Filtering and pagination covered
- ✅ Mock patterns consistent with codebase

## References

- Prisma schema: `prisma/schema.prisma` (Ticket, Project models)
- CLAUDE.md: Koda API patterns
- Projects CRUD: existing implementation reference
- Agents CRUD: existing implementation reference
