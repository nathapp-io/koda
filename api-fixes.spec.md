# SPEC: Koda API Bugfix Batch (PR #1)

## Summary
This spec addresses 5 critical API-layer bugs discovered during early Koda dogfooding. These issues block core functionality for AI agents (permissions) and cause data/UI inconsistencies (missing ref field, status no-op).

## Motivation
- **Agents are blocked**: Currently agents get 403 Forbidden when creating labels or deleting tickets despite being authorized.
- **Data Inconsistency**: `PATCH` updates to ticket status are ignored.
- **UI/CLI Fallback**: The API doesn't return the formatted `ref` (e.g., `NAX-1`), forcing clients to guess/hardcode prefixes.

## Design
- **Auth**: Update `JwtAuthGuard` and `LabelsService`/`TicketsService` to allow `AGENT` actors with `MEMBER` or `ADMIN` roles.
- **DTOs**: Extend `TicketResponseDto` to include a calculated `ref` field.
- **Service Logic**: Fix `TicketsService.update()` to correctly commit status transitions through the state machine.

## Stories

### US-001: Agent Permissions for Labels and Tickets
**Bugs: #18, #19**
- Ensure `LabelsService.create()` allows `AGENT` actors.
- Ensure `TicketsService.remove()` (delete) allows `AGENT` actors.
- **Acceptance Criteria**:
  - `LabelsService.create()` returns the new label when called by an `AGENT` actor with `role: 'MEMBER'`.
  - `TicketsService.remove()` successfully deletes a ticket when called by an `AGENT` actor.
  - API returns `403 Forbidden` only when the actor role is insufficient (e.g., a non-member agent).

### US-002: Safe Handling of Empty Descriptions
**Bug: #20**
- Fix ticket creation failing when `description` is `""`.
- **Acceptance Criteria**:
  - `TicketsService.create()` successfully creates a ticket when `createDto.description` is an empty string.
  - The resulting ticket in the database has `description` set to `null` or `""` (no exception thrown).

### US-003: Fix Ticket Status Update (No-op)
**Bug: #21**
- Fix `PATCH /api/projects/:slug/tickets/:ref` failing to update status.
- **Acceptance Criteria**:
  - When `PATCH` is called with `{ "status": "IN_PROGRESS" }`, the database record is updated.
  - The API response returns the updated status.
  - Transitions follow the `validateTransition()` logic in the state machine.

### US-004: Calculated 'ref' field in API Responses
**Bug: #23**
- Add `ref` field (e.g., `NAX-1`) to `TicketResponseDto`.
- **Acceptance Criteria**:
  - `GET /api/projects/:slug/tickets` returns objects containing a `ref` string.
  - The `ref` string matches the pattern `{projectKey}-{number}`.
  - `GET /api/projects/:slug/tickets/:ref` also includes the `ref` field in the response.

## Context Files
- `apps/api/src/tickets/tickets.service.ts` — main ticket logic
- `apps/api/src/labels/labels.service.ts` — label permissions
- `apps/api/src/tickets/dto/ticket-response.dto.ts` — response schema
- `apps/api/src/tickets/state-machine/` — status transition logic
