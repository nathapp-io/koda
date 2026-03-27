# SPEC: Koda API Bugfix Batch — PR #1

## Summary

Five bugs found during Koda dogfooding that block agent usage and cause data inconsistencies. This spec covers the 3 remaining unresolved bugs (US-001 was already fixed). All fixes are in the API layer only.

## Motivation

- **Bug #20**: Agents cannot create tickets with an empty description — the service throws a 400 even though an empty description is semantically valid (treat as null).
- **Bug #21**: PATCH `/tickets/:ref` silently ignores `status` in the request body — the `UpdateTicketDto` has no `status` field and `TicketsService.update()` never sets it.
- **Bug #23**: `GET /tickets` and `GET /tickets/:ref` do not include a `ref` field (e.g. `NAX-1`) in the response — `TicketResponseDto` has no `ref` field and `findAll()` does not compute it.

## Design

### Bug #20 — Remove empty-string guard in TicketsService.create()

`apps/api/src/tickets/tickets.service.ts` lines 76–78 throw `ValidationAppException` when `description` is an empty string:

```ts
// REMOVE these 3 lines:
if (createTicketDto.description !== undefined && typeof createTicketDto.description === 'string' && createTicketDto.description.trim().length === 0) {
  throw new ValidationAppException();
}
```

Line 94 already handles `description: createTicketDto.description || null` — empty string becomes `null` naturally. No other changes needed.

### Bug #21 — Add status to UpdateTicketDto and TicketsService.update()

Step 1 — Add to `apps/api/src/tickets/dto/update-ticket.dto.ts`:
```ts
@ApiProperty({ description: 'Ticket status', enum: TicketStatus, required: false })
@IsOptional()
@IsEnum(TicketStatus, { message: '$t(common.validation.isEnum)' })
status?: TicketStatus;
```

Step 2 — Add to `TicketsService.update()` after the `priority` block:
```ts
if (updateTicketDto.status !== undefined) {
  validateTransition(ticket.status, updateTicketDto.status);
  updateData.status = updateTicketDto.status;
}
```

Import `validateTransition` from `./state-machine/ticket-transitions`.

Note: Only transitions with `'NONE'` comment requirement (e.g. `CREATED → IN_PROGRESS`, `VERIFIED → IN_PROGRESS`) can be triggered via PATCH. Transitions requiring a comment type still go through the dedicated `/verify`, `/fix`, etc. endpoints.

### Bug #23 — Add ref field to TicketResponseDto and findAll()

Step 1 — Add to `apps/api/src/tickets/dto/ticket-response.dto.ts` (after `number`):
```ts
@ApiProperty({ description: 'Project-scoped ticket reference, e.g. NAX-1' })
ref!: string;
```

Step 2 — In `TicketsService.findAll()`, the `items` map currently spreads each ticket and adds `gitRefUrl`. Add `ref` computation:
```ts
items: tickets.map((ticket) => ({
  ...ticket,
  ref: `${project.key}-${ticket.number}`,
  gitRefUrl: this.computeGitRefUrl(...),
})),
```

The `project` variable is already in scope in `findAll()`.

## Stories

### US-002: Remove empty-description guard in ticket create

**Bug: #20**

#### Acceptance Criteria

1. When `TicketsService.create()` is called with `createTicketDto.description === ''`, it does not throw and returns a ticket object with `description === null`
2. When `TicketsService.create()` is called with `createTicketDto.description === undefined`, it returns a ticket with `description === null` (existing behaviour preserved)
3. When `TicketsService.create()` is called with `createTicketDto.description === 'some text'`, it returns a ticket with `description === 'some text'` (existing behaviour preserved)
4. `POST /api/projects/:slug/tickets` with body `{ type: 'BUG', title: 'T', description: '' }` returns HTTP 201 with a response body where `description` is `null`

#### Context Files

- `apps/api/src/tickets/tickets.service.ts` — remove lines 76–78 (the empty-string description guard)
- `apps/api/src/tickets/tickets.service.spec.ts` — add unit tests for empty-string description

---

### US-003: Fix ticket status PATCH no-op

**Bug: #21**

#### Acceptance Criteria

1. When `TicketsService.update()` is called with `updateTicketDto.status === 'IN_PROGRESS'` on a ticket with `status === 'CREATED'`, it calls `validateTransition('CREATED', 'IN_PROGRESS')` and returns the updated ticket where `status === 'IN_PROGRESS'`
2. When `TicketsService.update()` is called with `updateTicketDto.status === 'IN_PROGRESS'` on a ticket with `status === 'CREATED'`, the Prisma `db.ticket.update()` call receives `data` containing `status: 'IN_PROGRESS'`
3. When `TicketsService.update()` is called with an invalid transition (e.g. `status === 'CLOSED'` on a `'CREATED'` ticket), `validateTransition` throws `ValidationAppException` and the DB is not updated
4. When `TicketsService.update()` is called with no `status` field in `updateTicketDto`, `updateData` does not contain a `status` key (existing behaviour preserved)
5. `PATCH /api/projects/:slug/tickets/:ref` with body `{ status: 'IN_PROGRESS' }` on a `CREATED` ticket returns HTTP 200 with `status === 'IN_PROGRESS'`

#### Context Files

- `apps/api/src/tickets/dto/update-ticket.dto.ts` — add `status?: TicketStatus` field
- `apps/api/src/tickets/tickets.service.ts` — add status handling block in `update()` method
- `apps/api/src/tickets/state-machine/ticket-transitions.ts` — `validateTransition()` function (read-only, import it)
- `apps/api/src/tickets/tickets.service.spec.ts` — add unit tests for status update

---

### US-004: Add `ref` field to ticket API responses

**Bug: #23**

#### Acceptance Criteria

1. `TicketResponseDto` has a non-optional property `ref` of type `string` decorated with `@ApiProperty`
2. When `TicketsService.findAll()` returns items, each item contains a `ref` string equal to `${project.key}-${ticket.number}` (e.g. `'NAX-1'` for project key `'NAX'` and ticket number `1`)
3. `GET /api/projects/:slug/tickets` returns an array of items where each item contains a `ref` string matching the pattern `/^[A-Z0-9]+-[1-9][0-9]*$/`
4. `GET /api/projects/:slug/tickets/:ref` already returns `ref` via `findByRef()` — write a test asserting it is present and equals `${projectKey}-${number}`
5. `POST /api/projects/:slug/tickets` already returns `ref` via `create()` — write a test asserting it is present and equals `${projectKey}-1` for the first ticket in a project

#### Context Files

- `apps/api/src/tickets/dto/ticket-response.dto.ts` — add `ref!: string` field
- `apps/api/src/tickets/tickets.service.ts` — update `findAll()` items map to include `ref`
- `apps/api/src/tickets/tickets.service.spec.ts` — add unit tests for ref in list/create/findByRef

## Implementation Order

```
US-002 (remove empty-desc guard)  → independent
US-003 (status PATCH)             → independent
US-004 (ref field)                → independent
```

All three are independent and can run in parallel, but run sequentially per William's instruction.
