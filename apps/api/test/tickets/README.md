# Tickets Test Suite

Comprehensive test suite for the Tickets CRUD feature (US-003).

## Test Files

### 1. `tickets.service.spec.ts` (Unit Tests)
Unit tests for the `TicketsService` covering:

#### Create (`describe('create')`)
- ✓ Auto-increment ticket numbers
- ✓ Sequential numbering (KODA-1, KODA-2, etc.)
- ✓ No duplicate numbers on concurrent creates
- ✓ Project validation (404 if not found)
- ✓ Creator assignment (userId/agentId)
- ✓ Required field validation
- ✓ Default values (status=CREATED, priority=MEDIUM)

#### Find All (`describe('findAll')`)
- ✓ Return all tickets excluding soft-deleted
- ✓ Filter by status
- ✓ Filter by type
- ✓ Filter by priority
- ✓ Filter by assignedTo (userId)
- ✓ Filter for unassigned tickets
- ✓ Pagination (limit, page)
- ✓ Empty results handling
- ✓ Soft-delete exclusion

#### Find By Ref (`describe('findByRef')`)
- ✓ Resolve by KODA-42 format (projectKey-number)
- ✓ Resolve by CUID
- ✓ Case-insensitive handling
- ✓ 404 when not found
- ✓ Soft-delete exclusion
- ✓ Format validation

#### Update (`describe('update')`)
- ✓ Update ticket fields
- ✓ Prevent immutable field updates (number, projectId)
- ✓ 404 when not found
- ✓ Partial updates support
- ✓ Preserve unchanged fields

#### Soft Delete (`describe('softDelete')`)
- ✓ Set deletedAt timestamp
- ✓ Preserve ticket data (no hard delete)
- ✓ Require ADMIN role
- ✓ 404 when not found

#### Assign (`describe('assign')`)
- ✓ Assign to user
- ✓ Assign to agent
- ✓ Unassign (clear both)
- ✓ Prevent both userId and agentId
- ✓ 404 when not found

### 2. `tickets.controller.spec.ts` (HTTP Layer Tests)
HTTP request/response tests for `TicketsController`:

#### POST /api/projects/:slug/tickets
- ✓ Create ticket (201 status)
- ✓ Allow all authenticated users
- ✓ Validate DTO fields
- ✓ Handle missing project (404)
- ✓ Require authentication (401)

#### GET /api/projects/:slug/tickets
- ✓ Return paginated list
- ✓ Filter by status, type, priority
- ✓ Filter by assignedTo
- ✓ Filter for unassigned
- ✓ Apply limit and page
- ✓ Return empty list
- ✓ Handle missing project (404)
- ✓ Require authentication (401)

#### GET /api/projects/:slug/tickets/:ref
- ✓ Resolve by KODA-42
- ✓ Resolve by CUID
- ✓ Handle not found (404)
- ✓ Require authentication (401)

#### PATCH /api/projects/:slug/tickets/:ref
- ✓ Update ticket fields
- ✓ Allow authenticated users
- ✓ Support partial updates
- ✓ Prevent immutable updates
- ✓ Validate update data (400)
- ✓ Handle not found (404)
- ✓ Require authentication (401)

#### DELETE /api/projects/:slug/tickets/:ref
- ✓ Soft-delete for ADMIN (200)
- ✓ Reject non-ADMIN users (403)
- ✓ Reject agents (403)
- ✓ Handle not found (404)
- ✓ Require authentication (401)

#### POST /api/projects/:slug/tickets/:ref/assign
- ✓ Assign to user
- ✓ Assign to agent
- ✓ Unassign
- ✓ Replace previous assignment
- ✓ Reject both assignees (400)
- ✓ Handle not found (404)
- ✓ Require authentication (401)

### 3. `tickets.integration.spec.ts` (Integration Tests)
Integration tests combining service and database:

#### Sequential Numbering
- ✓ Sequential numbers from 1
- ✓ No duplicate numbers
- ✓ Concurrent safety (transaction-based)

#### Dual-Ref Resolution
- ✓ Resolve KODA-42 format correctly
- ✓ Resolve CUID correctly
- ✓ Differentiate between formats
- ✓ Extract project key from KODA-42

#### Filtering
- ✓ Filter by status
- ✓ Filter by multiple criteria
- ✓ Exclude soft-deleted from filters

#### Soft Delete
- ✓ Soft-delete preserves data
- ✓ Soft-deleted excluded from findAll
- ✓ Soft-deleted excluded from findByRef

#### Complete Lifecycle
- ✓ Create → Retrieve → Update → Delete workflow

#### Pagination
- ✓ Respect limit parameter
- ✓ Calculate correct skip offset
- ✓ Handle pagination boundaries

### 4. `tickets.e2e.spec.ts` (E2E Tests)
End-to-end tests simulating real HTTP requests:

#### POST /api/projects/:slug/tickets
- ✓ Returns 201 status
- ✓ Auto-increments numbers
- ✓ Default status = CREATED
- ✓ Default priority = MEDIUM
- ✓ Sets createdByUserId/createdByAgentId
- ✓ Validates request body (400)
- ✓ Requires authentication (401)

#### GET /api/projects/:slug/tickets
- ✓ Returns paginated list with metadata
- ✓ Filters work correctly
- ✓ Excludes soft-deleted
- ✓ Pagination limits work
- ✓ Combines multiple filters
- ✓ Returns 404 for missing project
- ✓ Requires authentication (401)

#### GET /api/projects/:slug/tickets/:ref
- ✓ Resolves KODA-42 format
- ✓ Resolves CUID format
- ✓ Case-insensitive resolution
- ✓ Returns 404 for missing ticket/project
- ✓ Requires authentication (401)

#### PATCH /api/projects/:slug/tickets/:ref
- ✓ Updates fields correctly
- ✓ Supports partial updates
- ✓ Prevents immutable updates
- ✓ Validates update data (400)
- ✓ Requires authentication (401)

#### DELETE /api/projects/:slug/tickets/:ref
- ✓ Soft-deletes for ADMIN users
- ✓ Rejects non-ADMIN users (403)
- ✓ Sets deletedAt timestamp
- ✓ Preserves ticket ID
- ✓ Requires authentication (401)

#### POST /api/projects/:slug/tickets/:ref/assign
- ✓ Assigns to user/agent
- ✓ Unassigns when no assignee
- ✓ Replaces previous assignment
- ✓ Rejects both assignees (400)
- ✓ Requires authentication (401)

#### Concurrent Operations
- ✓ No duplicate numbers under concurrency
- ✓ Handles 10 concurrent creates safely

#### Query Parameter Validation
- ✓ Rejects invalid status/type/priority values
- ✓ Validates page/limit are integers
- ✓ Rejects negative values
- ✓ Enforces maximum limits

#### Response Format
- ✓ Includes all required fields
- ✓ ISO 8601 date formatting
- ✓ No sensitive internal fields

## Test Coverage

### Endpoints Covered

| Method | Endpoint | Status |
|--------|----------|--------|
| POST | /api/projects/:slug/tickets | ✅ |
| GET | /api/projects/:slug/tickets | ✅ |
| GET | /api/projects/:slug/tickets/:ref | ✅ |
| PATCH | /api/projects/:slug/tickets/:ref | ✅ |
| DELETE | /api/projects/:slug/tickets/:ref | ✅ |
| POST | /api/projects/:slug/tickets/:ref/assign | ✅ |

### Features Covered

| Feature | Tests |
|---------|-------|
| Auto-increment numbers | 9 tests |
| Dual-ref resolution | 8 tests |
| Filtering (status, type, priority, etc.) | 12 tests |
| Pagination | 5 tests |
| Soft delete | 6 tests |
| Assignment | 7 tests |
| Concurrent operations | 3 tests |
| Authentication/Authorization | 15+ tests |
| Validation | 10+ tests |
| Error handling | 10+ tests |

## Running Tests

```bash
# Run all tickets tests
bun run test -- test/tickets

# Run specific test file
bun run test -- test/tickets/tickets.service.spec.ts
bun run test -- test/tickets/tickets.controller.spec.ts
bun run test -- test/tickets/tickets.integration.spec.ts
bun run test -- test/tickets/tickets.e2e.spec.ts

# Run tests matching pattern
bun run test -- test/tickets -t "sequential numbering"

# Run with coverage
bun run test -- test/tickets --coverage
```

## Test Status

Current status: **RED** (All tests are failing)

Tests are failing because the source files don't exist:
- `src/tickets/tickets.service.ts` - Not implemented
- `src/tickets/tickets.controller.ts` - Not implemented
- `src/tickets/dto/create-ticket.dto.ts` - Not implemented
- `src/tickets/dto/update-ticket.dto.ts` - Not implemented
- `src/tickets/dto/list-tickets-query.dto.ts` - Not implemented
- `src/tickets/dto/assign-ticket.dto.ts` - Not implemented

## Implementation Notes

These tests follow the Koda project conventions:
- Mocked PrismaService for unit/controller tests
- Transaction-based number generation for safety
- Soft deletes (deletedAt) instead of hard deletes
- Polymorphic creator/assignee (user OR agent)
- State machine validation for status transitions
- JWT auth for users, API key auth for agents
- ADMIN role required for deletion

See `CLAUDE.md` in the repository root for architectural details.
