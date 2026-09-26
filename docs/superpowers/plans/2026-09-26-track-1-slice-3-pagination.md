# Track 1 Slice 3 — Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace koda's three ad-hoc pagination patterns with one validated `current`/`size` query and one `IPageResult<T>` envelope for the ticket and memory lists, and push `take` plus a real keyset cursor into the timeline and `/context` event queries so neither loads a project's whole event history. Closes review finding M20.

**Architecture:** A shared `KodaPageQuery` (extends `@nathapp/nestjs-common` `PageOption`) validates `current`/`size`. Repositories page with `@nathapp/nestjs-prisma` `Paginate()` and return `Page<T>` (mapping rows with `Page#remap`). Services map records to DTOs with `remapPage()`, which depends only on the `IPageResult` port. Controllers turn the page into a plain six-field object with `toPageResult()` before `JsonResponse.Ok`. The timeline keeps its cursor contract but the cursor becomes an opaque `(createdAt, id)` keyset: each of the three event tables is queried with `where (createdAt, id) < cursor`, `take: limit + 1`, and the results are merged in memory.

**Tech Stack:** NestJS 11 + Fastify, Prisma 6 on Postgres 16, `@nathapp/nestjs-common` / `nestjs-data` / `nestjs-prisma` 3.3.0, class-validator + class-transformer, Jest (ts-jest), Nuxt 3 web (Jest), Commander CLI with a `@hey-api/openapi-ts` generated client, Bun 1.3.x.

**Spec:** `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md`, section "Slice 3 — Pagination". Read it before starting.

**Branch:** `feat/track1-pagination` (already created off `main` @ `2e0d570e`).

## Global Constraints

- Page query (verbatim from the spec): `current` is `@Type(() => Number) @IsInt() @Min(1)`, default 1; `size` is `@Type(() => Number) @IsInt() @Min(1) @Max(100)`, default 20. Every paginated list query DTO extends `KodaPageQuery`.
- Package map (verbatim from the spec): `PageOption`, `IPageOption`, `Page<T>` from `@nathapp/nestjs-common`; `IPageResult<T>` from `@nathapp/nestjs-data`; `Paginate()` from `@nathapp/nestjs-prisma`. Repositories and services declare `IPageResult<T>`; concrete repositories return `Page<T>` instances.
- **The global `ValidationPipe` runs with `transform: false`** (`@nathapp/nestjs-app` `useAppGlobalPipes()` sets only `forbidUnknownValues: false, stopAtFirstError: true`). It rejects an invalid query with 400, but the handler still receives the **raw string object**: no numbers, no defaults. Every controller that takes a paginated query DTO converts it with `parseQuery(Cls, raw)` (Task 1) before using it. Never read `query.current` straight off `@Query()`.
- **`Page` instances are not JSON-clean.** The constructor sets `transformOptions = {}` and `extra`, and `JsonResponse.Ok` does not run class-transformer, so both would reach the wire. Controllers return `toPageResult(page)` (Task 1), which has exactly `total, current, size, hasNext, hasPrev, records`.
- Timeline and context keep the keyset cursor. They are the one documented exception to the `Page<T>` rule. The timeline response is `{ events, nextCursor? }`, and `total` is removed (it was only correct because the old code loaded everything). The timeline `limit` is validated `1..100` (400 outside), default 50.
- The timeline cursor is opaque: base64url of `<createdAt ISO>|<id>`. A cursor that does not decode (including an old-style bare event id from a pre-upgrade client) is `400 { cursor: 'Invalid cursor' }`, never a 500.
- The in-memory merge order must match Postgres: `createdAt desc, id desc`, with ids compared by code unit (`<`/`>`), not `localeCompare`. cuids are lowercase alphanumeric, where code-unit and the database's collation agree. Test fixtures that set explicit ids use lowercase letters and digits only (no `-` or `_`: glibc collations ignore punctuation at the first level).
- Comments, labels, agents and links lists are unchanged: plain `T[]`, no paging params.
- Paging reads never run inside `txManager.run` (`Paginate()` issues `findMany` and `count` with `Promise.all`, which Prisma interactive transactions forbid).
- Follow `nathapp-nestjs-patterns`: repository → service → controller, `ValidationAppException` for 400s, no `console.log` in the API, no raw `process.env` outside config files and test harnesses.
- `bun run test` (unit) must pass with **no database running**. DB-backed tests live under `test/integration/` and are gated by `KODA_DB_TESTS === '1'`. Run them with `bun run test:db:up && bun run test:integration` from `apps/api` (PG16 on port 5433).
- Never edit generated files (`apps/cli/src/generated/`, root `openapi.json`) by hand. Regenerate with `bun run generate` from the repo root.
- Do not push, open a PR, or touch `projects/koda/deployments/koda-local` without the user's explicit approval at that moment.
- Git: the rtk hook rewrites git commands. If one misbehaves, prefix it with `RTK_DISABLED=1`.

## Review Focus

1. **Numbers and defaults through a `transform: false` pipe.** `GET /tickets?current=2&size=5` hands the controller `{ current: '2', size: '5' }`, and a request with no params hands it `{}`. The repository must receive numbers `2`/`5` and `1`/`20`, never strings or `undefined`. (`resolvePageOption` would silently coerce `'2'`, but `Page` would echo the string back and `hasNext` math on strings breaks.) Pinned in Task 2 and Task 3 controller tests.
2. **The wire shape of a page.** A `Page` serialized as-is carries `transformOptions: {}`. The JSON body must have exactly the six `IPageResult` keys. Pinned in Task 1 (`toPageResult`) and Task 2 (controller).
3. **A page past the end.** `current=999` on a 3-ticket project is a normal 200 with `records: []`, `total: 3`, `hasNext: false`, `hasPrev: true`, not a 400 and not a clamp back to the last page. Pinned in Task 2 integration.
4. **A garbage or pre-upgrade timeline cursor.** Clients (web, CLI scripts) may still hold an old bare-id cursor across the deploy. It must be a 400 `Invalid cursor`, never a 500 from `new Date('garbage')` reaching Prisma. Pinned in Task 4 unit.
5. **A timeline cursor combined with `from`/`to`.** The keyset condition must be ANDed with the `createdAt` range, not spread over it (a spread `{ ...where, createdAt: … }` silently drops the range). Pinned in Task 4 unit (where shape) and Task 4 integration.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `apps/api/src/common/dto/koda-page.query.ts` (+ `.spec.ts`) | `KodaPageQuery`, `parseQuery()`, `toPageResult()`, `remapPage()` | 1 |
| `apps/api/src/tickets/dto/list-tickets.query.ts` (+ `.spec.ts`) | validated ticket list query | 2 |
| `apps/api/src/tickets/domain/ticket.domain.ts` | `TicketListFilters`; `findTicketPage` replaces `findTicketsByProject` + `countTicketsByProject` | 2 |
| `apps/api/src/tickets/prisma-tickets.repository.ts` | `findTicketPage` via `Paginate()` | 2 |
| `apps/api/src/tickets/tickets.service.ts` (+ spec) | `findAll(slug, filters, page)` → `IPageResult<TicketResponseDto>` | 2 |
| `apps/api/src/tickets/tickets.controller.ts` (+ spec) | `@Query() ListTicketsQuery`; drops hand parsing and `@ApiQuery` list | 2 |
| `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts` | filters + paging on real PG | 2 |
| `apps/api/src/memory/dto/list-memory.query.ts` (+ `.spec.ts`) | validated memory list query | 3 |
| `apps/api/src/memory/memory-item-repository.ts` | types only: `PaginatedResult` and the dead `MemoryItemRepository` class **deleted**; `page`/`limit` removed from query types | 3 |
| `apps/api/src/memory/prisma-memory-item.repository.ts` (+ specs) | `findByProject` / `findByProjectMemory` take an `IPageOption`, return `IPageResult` | 3 |
| `apps/api/src/memory/memory-governance.service.ts` (+ spec) | reads `.records`; passes `PageOption` | 3 |
| `apps/api/src/memory/memory-read.controller.ts` (+ spec) | `@Query() ListMemoryQuery`; returns `toPageResult` | 3 |
| `apps/api/src/context/context-builder.service.ts` (+ 5 specs in `src/context/` and `test/unit/context/`) | passes `PageOption.from(1, MAX_SEMANTIC_MEMORY)`, reads `.records`; passes `eventLimit` | 3, 5 |
| `apps/api/src/memory/event-order.ts` (+ `.spec.ts`) | `compareEventsDesc`, shared by timeline and context | 4 |
| `apps/api/src/memory/timeline-cursor.ts` (+ `.spec.ts`) | `encodeTimelineCursor` / `decodeTimelineCursor` / `keysetWhere` | 4 |
| `apps/api/src/memory/prisma-timeline.repository.ts` (+ spec) | optional `{ cursor, take }` per table | 4 |
| `apps/api/src/memory/timeline.service.ts` (+ spec) | keyset merge; `total` removed | 4 |
| `apps/api/src/memory/timeline.controller.ts` (+ spec) | strict `limit` 1..100 | 4 |
| `apps/api/test/integration/memory/timeline-pagination.integration.spec.ts` | three-table paging with a same-`createdAt` tie | 4 |
| `apps/api/src/memory/canonical-state.service.ts` | `CanonicalSnapshotQuery.eventLimit` | 5 |
| `apps/api/src/memory/prisma-canonical-state.repository.ts` (+ spec) | `take: eventLimit` per table, merge, cut | 5 |
| `openapi.json`, `apps/cli/src/generated/**` | regenerated | 6 |
| `apps/cli/src/commands/ticket.ts` (+ spec) | `--page` / `--size`; reads `records`, `hasNext` | 6 |
| `apps/cli/src/commands/memory.ts` (+ spec) | timeline reads `events` (pre-existing bug), prints the next cursor | 6 |
| `apps/web/pages/[project]/index.vue`, `tests/pages/project-board.spec.ts` | board reads `records`, "load more" on `hasNext` | 7 |
| `apps/web/composables/useMemory.ts` (+ spec) | reads `records` / `hasNext`, sends `current` | 7 |
| `apps/web/composables/useTimelineEvents.ts` | drops `total` from the response type | 7 |
| `docs/architecture.md`, spec status line | docs | 8 |

Note on the spec's "CLI `ticket list` / `memory`": the CLI has no memory **list** command (`memory` has `timeline`, `decisions`, `create`). Only `ticket list` and `ticket mine` change shape. The timeline command is fixed in Task 6 because it has read the wrong field (`items` instead of `events`) since it was written, so it always prints an empty table.

---

### Task 1: Shared page query, parser, and wire shape

**Files:**
- Create: `apps/api/src/common/dto/koda-page.query.ts`
- Test: `apps/api/src/common/dto/koda-page.query.spec.ts`

**Interfaces:**
- Consumes: `PageOption`, `Page` from `@nathapp/nestjs-common`; `IPageResult` from `@nathapp/nestjs-data`.
- Produces:
  - `class KodaPageQuery extends PageOption { current: number /* default 1 */; size: number /* default 20 */ }`
  - `function parseQuery<T extends object>(cls: new () => T, raw: object): T`: `plainToInstance` with class defaults applied
  - `function toPageResult<T>(page: IPageResult<T>): IPageResult<T>`: exactly the six fields
  - `function remapPage<S, T>(page: IPageResult<S>, fn: (item: S) => T): IPageResult<T>`: maps `records`, keeps the counters. Services use it, so they depend only on the `IPageResult` port, not on the concrete `Page` class.
  - `const KODA_PAGE_MAX_SIZE = 100`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/common/dto/koda-page.query.spec.ts
import { validate } from 'class-validator';
import { Page } from '@nathapp/nestjs-common';
import { KodaPageQuery, parseQuery, remapPage, toPageResult } from './koda-page.query';

async function errorsFor(raw: object): Promise<string[]> {
  const errors = await validate(parseQuery(KodaPageQuery, raw));
  return errors.map((e) => e.property);
}

describe('KodaPageQuery', () => {
  it('applies defaults when nothing is sent', async () => {
    const q = parseQuery(KodaPageQuery, {});
    expect(q.current).toBe(1);
    expect(q.size).toBe(20);
    expect(await errorsFor({})).toEqual([]);
  });

  it('converts query-string numbers', () => {
    const q = parseQuery(KodaPageQuery, { current: '3', size: '5' });
    expect(q.current).toBe(3);
    expect(q.size).toBe(5);
  });

  it.each([
    [{ size: '101' }, 'size'],
    [{ size: '0' }, 'size'],
    [{ size: '2.5' }, 'size'],
    [{ current: 'abc' }, 'current'],
    [{ current: '0' }, 'current'],
    [{ current: '-1' }, 'current'],
  ])('rejects %j', async (raw, property) => {
    expect(await errorsFor(raw)).toContain(property);
  });

  it('accepts the boundary size of 100', async () => {
    expect(await errorsFor({ size: '100' })).toEqual([]);
  });
});

describe('toPageResult', () => {
  it('keeps exactly the six IPageResult fields', () => {
    const page = new Page({ current: 2, size: 2 }, 5, ['c', 'd']);
    const result = toPageResult(page);
    expect(Object.keys(result).sort()).toEqual(
      ['current', 'hasNext', 'hasPrev', 'records', 'size', 'total'],
    );
    expect(result).toEqual({ total: 5, current: 2, size: 2, hasNext: true, hasPrev: true, records: ['c', 'd'] });
    expect(JSON.stringify(result)).not.toContain('transformOptions');
  });
});

describe('remapPage', () => {
  it('maps records and keeps the counters', () => {
    const mapped = remapPage(new Page({ current: 1, size: 2 }, 3, [1, 2]), (n: number) => n * 10);
    expect(mapped).toEqual(expect.objectContaining({ total: 3, current: 1, size: 2, hasNext: true, records: [10, 20] }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && bunx jest src/common/dto/koda-page.query.spec.ts`
Expected: FAIL with `Cannot find module './koda-page.query'`

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/common/dto/koda-page.query.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type, plainToInstance } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';

export const KODA_PAGE_MAX_SIZE = 100;

/**
 * Shared list query: 1-based `current`, `size` 1..100 (default 20).
 * The global ValidationPipe does not transform, so controllers must pass the
 * raw query through `parseQuery` to get numbers and defaults.
 */
export class KodaPageQuery extends PageOption {
  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  current: number = 1;

  @ApiPropertyOptional({ description: 'Page size', default: 20, minimum: 1, maximum: KODA_PAGE_MAX_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(KODA_PAGE_MAX_SIZE)
  size: number = 20;
}

export function parseQuery<T extends object>(cls: new () => T, raw: object): T {
  return plainToInstance(cls, raw);
}

/** A Page instance carries transformOptions/extra; send only the envelope. */
export function toPageResult<T>(page: IPageResult<T>): IPageResult<T> {
  const { total, current, size, hasNext, hasPrev, records } = page;
  return { total, current, size, hasNext, hasPrev, records };
}

/** Map a page's records without depending on the concrete Page class. */
export function remapPage<S, T>(page: IPageResult<S>, fn: (item: S) => T): IPageResult<T> {
  return { ...toPageResult(page), records: page.records.map(fn) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && bunx jest src/common/dto/koda-page.query.spec.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/common/dto/koda-page.query.ts apps/api/src/common/dto/koda-page.query.spec.ts
git commit -m "feat(api): shared KodaPageQuery, parseQuery, toPageResult and remapPage"
```

---

### Task 2: Ticket list on `Page<T>`

**Files:**
- Create: `apps/api/src/tickets/dto/list-tickets.query.ts`, `apps/api/src/tickets/dto/list-tickets.query.spec.ts`
- Create: `apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts`
- Modify: `apps/api/src/tickets/domain/ticket.domain.ts:58-67,97-98`
- Modify: `apps/api/src/tickets/prisma-tickets.repository.ts:143-205`
- Modify: `apps/api/src/tickets/tickets.service.ts:18-26,134-178`
- Modify: `apps/api/src/tickets/tickets.controller.ts:52-54,160-191`
- Modify: `apps/api/src/tickets/tickets.service.spec.ts` (the `findAll` block, ~line 360-510), `apps/api/src/tickets/tickets.controller.spec.ts`

**Interfaces:**
- Consumes: `KodaPageQuery`, `parseQuery`, `toPageResult`, `remapPage` (Task 1).
- Produces:
  - `class ListTicketsQuery extends KodaPageQuery { status?: TicketStatus; type?: TicketType; priority?: Priority; assignedTo?: string; unassigned?: boolean }`
  - `interface TicketListFilters { projectId: string; status?; type?; priority?; assignedToUserId?: string; unassigned?: boolean }` (in `ticket.domain.ts`, replaces `FindTicketsFilters`)
  - `ITicketRepository.findTicketPage(filters: TicketListFilters, page: IPageOption): Promise<IPageResult<TicketDomain>>`
  - `TicketsService.findAll(projectSlug: string, filters: TicketListFilterInput, page: IPageOption): Promise<IPageResult<TicketResponseDto>>` where `TicketListFilterInput = Omit<ListTicketsQuery, 'current' | 'size'>`

- [ ] **Step 1: Write the failing DTO test**

```ts
// apps/api/src/tickets/dto/list-tickets.query.spec.ts
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListTicketsQuery } from './list-tickets.query';

async function errorProps(raw: object): Promise<string[]> {
  return (await validate(parseQuery(ListTicketsQuery, raw))).map((e) => e.property);
}

describe('ListTicketsQuery', () => {
  it('accepts valid filters and inherits paging defaults', async () => {
    const q = parseQuery(ListTicketsQuery, { status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH' });
    expect(await validate(q)).toEqual([]);
    expect(q.current).toBe(1);
    expect(q.size).toBe(20);
  });

  it.each([
    [{ status: 'NOPE' }, 'status'],
    [{ type: 'NOPE' }, 'type'],
    [{ priority: 'NOPE' }, 'priority'],
    [{ unassigned: 'yes' }, 'unassigned'],
    [{ size: '101' }, 'size'],
  ])('rejects %j', async (raw, prop) => {
    expect(await errorProps(raw)).toContain(prop);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('parses unassigned=%s', (raw, expected) => {
    expect(parseQuery(ListTicketsQuery, { unassigned: raw }).unassigned).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && bunx jest src/tickets/dto/list-tickets.query.spec.ts`
Expected: FAIL with `Cannot find module './list-tickets.query'`

- [ ] **Step 3: Implement the DTO**

```ts
// apps/api/src/tickets/dto/list-tickets.query.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import { Priority, TicketStatus, TicketType } from '../../common/enums';

// 'true'/'false' become booleans; anything else is left as-is so @IsBoolean rejects it.
const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListTicketsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: TicketStatus })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketType })
  @IsOptional()
  @IsEnum(TicketType)
  type?: TicketType;

  @ApiPropertyOptional({ enum: Priority })
  @IsOptional()
  @IsEnum(Priority)
  priority?: Priority;

  @ApiPropertyOptional({ description: 'User ID to filter by' })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional({ type: Boolean, description: 'Only tickets with no user or agent assignee' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  unassigned?: boolean;
}
```

Run: `cd apps/api && bunx jest src/tickets/dto/list-tickets.query.spec.ts`
Expected: PASS

- [ ] **Step 4: Rewrite the service tests for the new contract (failing)**

In `apps/api/src/tickets/tickets.service.spec.ts`:
- In the mock repo (~line 105), replace `findTicketsByProject: jest.fn(), countTicketsByProject: jest.fn(),` with `findTicketPage: jest.fn(),`.
- Add `import { Page } from '@nathapp/nestjs-common';` at the top.
- Replace the whole `describe('findAll', …)` block with:

```ts
  describe('findAll', () => {
    const page1 = { current: 1, size: 20 };

    it('returns a page of response DTOs with refs and gitRefUrl', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketPage.mockResolvedValue(new Page(page1, 1, [mockTicket]));

      const result = await service.findAll('koda', {}, page1);

      expect(result.total).toBe(1);
      expect(result.current).toBe(1);
      expect(result.size).toBe(20);
      expect(result.hasNext).toBe(false);
      expect(result.records).toEqual([expect.objectContaining({ ref: 'KODA-1' })]);
      expect(result.records[0]).toHaveProperty('gitRefUrl');
    });

    it('maps filters to the repository and passes the page through', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue(mockProject);
      mockTicketRepo.findTicketPage.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

      await service.findAll(
        'koda',
        { status: 'IN_PROGRESS', type: 'BUG', priority: 'HIGH', assignedTo: 'user-1', unassigned: false },
        { current: 2, size: 5 },
      );

      expect(mockTicketRepo.findTicketPage).toHaveBeenCalledWith(
        {
          projectId: mockProject.id,
          status: 'IN_PROGRESS',
          type: 'BUG',
          priority: 'HIGH',
          assignedToUserId: 'user-1',
          unassigned: false,
        },
        { current: 2, size: 5 },
      );
    });

    it('throws NotFound for a missing or soft-deleted project', async () => {
      mockTicketRepo.findProjectBySlug.mockResolvedValue({ ...mockProject, deletedAt: new Date() });
      await expect(service.findAll('koda', {}, page1)).rejects.toThrow(NotFoundAppException);
      expect(mockTicketRepo.findTicketPage).not.toHaveBeenCalled();
    });
  });
```

(`NotFoundAppException` is already imported in this spec; if not, import it from `@nathapp/nestjs-common`.)

Run: `cd apps/api && bunx jest src/tickets/tickets.service.spec.ts -t findAll`
Expected: FAIL (`findTicketPage` is never called, and the result has no `records`)

- [ ] **Step 5: Change the domain port**

In `apps/api/src/tickets/domain/ticket.domain.ts`, replace `FindTicketsFilters` (lines 58-67) with:

```ts
export interface TicketListFilters {
  projectId: string;
  status?: TicketStatus;
  type?: TicketType;
  priority?: Priority;
  assignedToUserId?: string;
  unassigned?: boolean;
}
```

Replace the two interface members at lines 97-98 with:

```ts
  findTicketPage(filters: TicketListFilters, page: IPageOption): Promise<IPageResult<TicketDomain>>;
```

and add at the top of the file:

```ts
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
```

- [ ] **Step 6: Implement the repository**

In `apps/api/src/tickets/prisma-tickets.repository.ts`, delete `findTicketsByProject` and `countTicketsByProject` (lines 143-205) and add:

```ts
  async findTicketPage(filters: TicketListFilters, page: IPageOption): Promise<IPageResult<TicketDomain>> {
    const where: Prisma.TicketWhereInput = {
      projectId: filters.projectId,
      deletedAt: null,
      ...(filters.status && { status: filters.status }),
      ...(filters.type && { type: filters.type }),
      ...(filters.priority && { priority: filters.priority }),
      ...(filters.unassigned
        ? { assignedToUserId: null, assignedToAgentId: null }
        : filters.assignedToUserId
          ? { assignedToUserId: filters.assignedToUserId }
          : {}),
    };

    // `number` is unique per project, so it is a total order for offset paging.
    const rows = await Paginate(this.db.ticket, page, {
      where,
      orderBy: { number: 'asc' },
      include: { labels: { include: { label: true } }, links: true },
    });
    return rows.remap((row) => this.toDomain(row));
  }
```

Imports to add: `import { Paginate } from '@nathapp/nestjs-prisma';`, `import type { IPageOption } from '@nathapp/nestjs-common';`, `import type { IPageResult } from '@nathapp/nestjs-data';`, `Prisma` from `@prisma/client` if it is not already imported, and `TicketListFilters` from `./domain/ticket.domain` (replacing `FindTicketsFilters`). If `this.toDomain` is typed against a specific row type that TypeScript cannot infer from `remap`'s `any` parameter, annotate the lambda parameter with that same row type.

- [ ] **Step 7: Implement the service**

In `apps/api/src/tickets/tickets.service.ts`, replace the `FindAllFilters` interface (lines 18-26) with:

```ts
export type TicketListFilterInput = Omit<ListTicketsQuery, 'current' | 'size'>;
```

and replace `findAll` (lines 134-178) with:

```ts
  async findAll(
    projectSlug: string,
    filters: TicketListFilterInput,
    page: IPageOption,
  ): Promise<IPageResult<TicketResponseDto>> {
    const project = await this.ticketRepo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'tickets');
    }

    const tickets = await this.ticketRepo.findTicketPage(
      {
        projectId: project.id,
        status: filters.status,
        type: filters.type,
        priority: filters.priority,
        assignedToUserId: filters.assignedTo,
        unassigned: filters.unassigned,
      },
      page,
    );

    return remapPage(tickets, (ticket: TicketDomain) =>
      TicketResponseDto.from(
        ticket,
        project.key,
        this.computeGitRefUrl(project.gitRemoteUrl, ticket.gitRefVersion, ticket.gitRefFile, ticket.gitRefLine),
      ),
    );
  }
```

`TicketResponseDto.from(ticket, projectKey, gitRefUrl)` already sets `gitRefUrl` (`ticket-response.dto.ts:80,130`), so the old `tickets[i] as any` spread goes away.

Imports: `IPageOption` from `@nathapp/nestjs-common`, `IPageResult` from `@nathapp/nestjs-data`, `ListTicketsQuery` from `./dto/list-tickets.query`, `TicketDomain` from `./domain/ticket.domain`, `remapPage` from `../common/dto/koda-page.query`.

Run: `cd apps/api && bunx jest src/tickets/tickets.service.spec.ts src/common/dto`
Expected: PASS

- [ ] **Step 8: Controller test (failing): strings in, numbers out, clean envelope**

In `apps/api/src/tickets/tickets.controller.spec.ts`, replace any existing tests of `findAll` / `listTickets` with:

```ts
  describe('GET /projects/:slug/tickets', () => {
    it('parses the raw query into numbers and defaults before calling the service', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

      await controller.findAll('koda', { current: '2', size: '5', status: 'IN_PROGRESS' } as never);

      expect(mockTicketsService.findAll).toHaveBeenCalledWith(
        'koda',
        expect.objectContaining({ status: 'IN_PROGRESS' }),
        { current: 2, size: 5 },
      );
    });

    it('defaults to page 1 of 20 when no paging params are sent', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));

      await controller.findAll('koda', {} as never);

      expect(mockTicketsService.findAll).toHaveBeenCalledWith('koda', expect.anything(), { current: 1, size: 20 });
    });

    it('returns only the six page fields', async () => {
      mockTicketsService.findAll.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, [{ ref: 'KODA-1' }]));

      const res = await controller.findAll('koda', {} as never);

      expect(Object.keys(res.data).sort()).toEqual(['current', 'hasNext', 'hasPrev', 'records', 'size', 'total']);
    });
  });
```

Use whatever name this spec already gives the mocked `TicketsService` (for example `mockTicketsService` or `ticketsService`). Add `import { Page } from '@nathapp/nestjs-common';`. If `JsonResponse` exposes the payload under a different property than `data`, read `node_modules/@nathapp/nestjs-common/dist/serialize/json-response.js` and use that property.

Run: `cd apps/api && bunx jest src/tickets/tickets.controller.spec.ts`
Expected: FAIL (the service is called with the old filters object)

- [ ] **Step 9: Implement the controller**

In `apps/api/src/tickets/tickets.controller.ts`:
- Delete the `listTickets` test helper (lines 52-54). Tests call `findAll` directly.
- Replace the whole `@Get()` handler (lines 160-191) with:

```ts
  @Get()
  @ApiOperation({ summary: 'List tickets for a project (paginated)' })
  @ApiResponse({ status: 200, description: 'Page of tickets: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async findAll(@Param('slug') slug: string, @Query() rawQuery: ListTicketsQuery) {
    const { current, size, ...filters } = parseQuery(ListTicketsQuery, rawQuery);
    const page = await this.ticketsService.findAll(slug, filters, { current, size });
    return JsonResponse.Ok(toPageResult(page));
  }
```

- Remove `ApiQuery` from the swagger import if it is no longer used, and remove `TicketType`, `TicketStatus`, `Priority` from the enums import if they are no longer used. Add the imports for `ListTicketsQuery`, `parseQuery` and `toPageResult`.
- `grep -rn "listTickets(" apps/api/src apps/api/test` and move any remaining caller to `findAll`.

Run: `cd apps/api && bunx jest src/tickets`
Expected: PASS

- [ ] **Step 10: Integration test on real Postgres**

```ts
// apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts
/**
 * Slice 3 — ticket list paging and filters against real Postgres.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/tickets/ticket-pagination
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('ticket list pagination (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let repo: PrismaTicketsRepository;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prisma.onModuleInit();
    repo = new PrismaTicketsRepository(prisma);

    const project = await prisma.client.project.create({ data: { name: 'Paging', slug: 'paging', key: 'PG' } });
    projectId = project.id;

    // 7 live tickets (#1-#7): odd numbers IN_PROGRESS, even CREATED; #3 assigned; plus one soft-deleted (#8).
    for (let n = 1; n <= 8; n++) {
      await prisma.client.ticket.create({
        data: {
          projectId,
          number: n,
          type: 'BUG',
          title: `t${n}`,
          status: n % 2 === 1 ? 'IN_PROGRESS' : 'CREATED',
          priority: 'MEDIUM',
          assignedToUserId: n === 3 ? 'user-a' : null,
          deletedAt: n === 8 ? new Date() : null,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
  });

  it('pages in ticket-number order with correct total and flags', async () => {
    const p1 = await repo.findTicketPage({ projectId }, { current: 1, size: 3 });
    const p3 = await repo.findTicketPage({ projectId }, { current: 3, size: 3 });

    expect(p1.total).toBe(7);
    expect(p1.records.map((t) => t.number)).toEqual([1, 2, 3]);
    expect(p1.hasNext).toBe(true);
    expect(p1.hasPrev).toBe(false);
    expect(p3.records.map((t) => t.number)).toEqual([7]);
    expect(p3.hasNext).toBe(false);
  });

  it('counts only rows matching the filter', async () => {
    const page = await repo.findTicketPage({ projectId, status: 'IN_PROGRESS' }, { current: 1, size: 2 });
    expect(page.total).toBe(4); // #1 #3 #5 #7
    expect(page.records.map((t) => t.number)).toEqual([1, 3]);
    expect(page.hasNext).toBe(true);
  });

  it('unassigned excludes assigned tickets; assignedTo selects them', async () => {
    const unassigned = await repo.findTicketPage({ projectId, unassigned: true }, { current: 1, size: 20 });
    const mine = await repo.findTicketPage({ projectId, assignedToUserId: 'user-a' }, { current: 1, size: 20 });
    expect(unassigned.total).toBe(6);
    expect(mine.records.map((t) => t.number)).toEqual([3]);
  });

  it('a page past the end is empty, not an error', async () => {
    const page = await repo.findTicketPage({ projectId }, { current: 999, size: 3 });
    expect(page.records).toEqual([]);
    expect(page.total).toBe(7);
    expect(page.hasNext).toBe(false);
    expect(page.hasPrev).toBe(true);
  });
});
```

Run: `cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/tickets/ticket-pagination`
Expected: PASS (4 tests)

- [ ] **Step 11: Full unit run, type-check, commit**

Run: `cd apps/api && bun run test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors. Fix any other caller of the removed repository methods that `tsc` reports.

```bash
git add apps/api/src/tickets apps/api/src/common/dto apps/api/test/integration/tickets/ticket-pagination.integration.spec.ts
git commit -m "feat(api): paginate ticket list with validated ListTicketsQuery (Track 1 Slice 3)"
```

---

### Task 3: Memory list on `Page<T>`

**Files:**
- Create: `apps/api/src/memory/dto/list-memory.query.ts`, `apps/api/src/memory/dto/list-memory.query.spec.ts`
- Modify: `apps/api/src/memory/memory-item-repository.ts` (delete `PaginatedResult` at lines 28-33 and the `MemoryItemRepository` class from line 72 to the end of the file; drop `page`/`limit` from `MemoryQuery` and `ProjectMemoryQuery`)
- Modify: `apps/api/src/memory/prisma-memory-item.repository.ts:91-117,216-258`
- Modify: `apps/api/src/memory/memory-governance.service.ts` (lines 23-25 and the four `findByProject` loops at ~55, 94, 130, 187)
- Modify: `apps/api/src/memory/memory-read.controller.ts`
- Modify: `apps/api/src/context/context-builder.service.ts:108-112,124`
- Modify specs: `memory-read.controller.spec.ts`, `memory-governance.service.spec.ts`, `memory-item-repository.spec.ts`, `prisma-memory-item.repository.additional.spec.ts`, and all five context-builder specs that mock `findByProjectMemory`: `src/context/context-builder.service.spec.ts`, `test/unit/context/context-builder.service.spec.ts`, `test/unit/context/context-builder.service.token-budget.spec.ts`, `test/unit/context/context-builder.service.adversarial.spec.ts`, `test/unit/context/context-builder.service.slo-adversarial.spec.ts`

**Interfaces:**
- Consumes: `KodaPageQuery`, `parseQuery`, `toPageResult` (Task 1).
- Produces:
  - `class ListMemoryQuery extends KodaPageQuery { kind?: MemoryKind; subject?: string; status?: 'active' | 'superseded' | 'rejected'; orderBy?: 'confidence' | 'updatedAt' | 'createdAt' }`
  - `PrismaMemoryItemRepository.findByProject(query: MemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>>`
  - `PrismaMemoryItemRepository.findByProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>>`
  - `MemoryGovernanceService.getProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>>`

The dead class: `MemoryItemRepository` in `memory-item-repository.ts` has no importer (`grep -rnw MemoryItemRepository apps/api/src` finds only its definition; the test files declare their own local interface of the same name). The module wires `PrismaMemoryItemRepository`. Delete the class rather than port it. Keep the file for its exported types.

Behavior changes (intentional, from the spec): the default memory page size goes from 10 to 20, and the ceiling from a silent clamp at 50 to a 400 above 100.

- [ ] **Step 1: DTO test (failing)**

```ts
// apps/api/src/memory/dto/list-memory.query.spec.ts
import { validate } from 'class-validator';
import { parseQuery } from '../../common/dto/koda-page.query';
import { ListMemoryQuery } from './list-memory.query';

async function errorProps(raw: object): Promise<string[]> {
  return (await validate(parseQuery(ListMemoryQuery, raw))).map((e) => e.property);
}

describe('ListMemoryQuery', () => {
  it('accepts valid filters', async () => {
    expect(await errorProps({ kind: 'FACT', subject: 'ticket:1', status: 'superseded', orderBy: 'updatedAt' })).toEqual([]);
  });

  it.each([
    [{ kind: 'NOPE' }, 'kind'],
    [{ status: 'deleted' }, 'status'],
    [{ orderBy: 'id' }, 'orderBy'],
    [{ size: '101' }, 'size'],
  ])('rejects %j', async (raw, prop) => {
    expect(await errorProps(raw)).toContain(prop);
  });
});
```

Run: `cd apps/api && bunx jest src/memory/dto/list-memory.query.spec.ts`
Expected: FAIL with `Cannot find module './list-memory.query'`

- [ ] **Step 2: Implement the DTO**

```ts
// apps/api/src/memory/dto/list-memory.query.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsOptional, IsString } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import { MemoryKind } from '../../common/enums';

export const MEMORY_STATUSES = ['active', 'superseded', 'rejected'] as const;
export const MEMORY_ORDER_BY = ['confidence', 'updatedAt', 'createdAt'] as const;

export class ListMemoryQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: MemoryKind })
  @IsOptional()
  @IsEnum(MemoryKind)
  kind?: MemoryKind;

  @ApiPropertyOptional({ description: 'Subject prefix' })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiPropertyOptional({ enum: MEMORY_STATUSES, description: 'Defaults to active, non-expired items' })
  @IsOptional()
  @IsIn(MEMORY_STATUSES)
  status?: (typeof MEMORY_STATUSES)[number];

  @ApiPropertyOptional({ enum: MEMORY_ORDER_BY, default: 'confidence' })
  @IsOptional()
  @IsIn(MEMORY_ORDER_BY)
  orderBy?: (typeof MEMORY_ORDER_BY)[number];
}
```

Run: `cd apps/api && bunx jest src/memory/dto/list-memory.query.spec.ts`
Expected: PASS

- [ ] **Step 3: Repository tests (failing)**

In `apps/api/src/memory/memory-item-repository.spec.ts` (it tests `PrismaMemoryItemRepository.findByProjectMemory`) and `prisma-memory-item.repository.additional.spec.ts` (tests `findByProject`):
- Change every call to pass the page as the second argument: `findByProjectMemory({ projectId, … }, { current: 1, size: 10 })` and `findByProject({ projectId, … }, { current: 1, size: 20 })`. Move any `page`/`limit` that a test put in the query object into that second argument (`page` → `current`, `limit` → `size`).
- Change result assertions from `result.items` / `result.data` to `result.records`, and from `{ items, total }` / `{ data, total, page, limit }` to `expect.objectContaining({ records: [...], total, current, size })`.
- Delete any test that asserts the old clamp (`limit` 999 → 50, or `page` 0 → 1). Validation now lives in the DTO (Step 1).
- Add a test asserting that the mocked `findMany` receives `skip: 20, take: 10` for `{ current: 3, size: 10 }`.
- The mocked Prisma delegate must provide both `findMany` and `count` (`Paginate` calls both).

Run: `cd apps/api && bunx jest src/memory/memory-item-repository.spec.ts src/memory/prisma-memory-item.repository.additional.spec.ts`
Expected: FAIL (`records` is undefined)

- [ ] **Step 4: Implement the repository**

In `apps/api/src/memory/memory-item-repository.ts`: delete `PaginatedResult` and the `MemoryItemRepository` class (and the now-unused `Injectable` / `PrismaService` imports), and remove the `page?` / `limit?` members from `MemoryQuery` and `ProjectMemoryQuery`.

In `apps/api/src/memory/prisma-memory-item.repository.ts`, replace `findByProject` with:

```ts
  async findByProject(query: MemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>> {
    const where: Record<string, unknown> = {
      projectId: query.projectId,
      deletedAt: null,
      status: query.status ?? 'active',
    };
    if (query.kind) where.kind = query.kind;
    if (query.subject) where.subject = query.subject;
    if (query.predicate) where.predicate = query.predicate;
    if (query.activeKey !== undefined) where.activeKey = query.activeKey;
    if (query.sourceType) where.sourceType = query.sourceType;
    if (query.sourceId) where.sourceId = query.sourceId;

    // Unique tiebreaker: rows created in the same burst share timestamps and
    // Postgres does not guarantee a stable order among ties, which would
    // shuffle items across pagination pages.
    const models = await Paginate(this.prisma.client.memoryItem, page, {
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return models.remap((m) => this.toDomain(m));
  }
```

and replace `findByProjectMemory` with the same `where` / `orderByClause` construction it has today (lines 222-250 unchanged), ending in:

```ts
    const models = await Paginate(this.prisma.client.memoryItem, page, { where, orderBy: orderByClause });
    return models.remap((m) => this.toDomain(m));
```

Its signature becomes `findByProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>>`, and the `limit` / `page` / `skip` lines at the top are deleted. Imports: `Paginate` from `@nathapp/nestjs-prisma`, `IPageOption` from `@nathapp/nestjs-common`, `IPageResult` from `@nathapp/nestjs-data`; drop `PaginatedResult`. Type the `m` parameter as the Prisma `MemoryItem` model row if `toDomain` needs it.

Run: `cd apps/api && bunx jest src/memory/memory-item-repository.spec.ts src/memory/prisma-memory-item.repository.additional.spec.ts`
Expected: PASS

- [ ] **Step 5: Governance service**

In `apps/api/src/memory/memory-governance.service.ts`:
- `getProjectMemory(query: ProjectMemoryQuery, page: IPageOption): Promise<IPageResult<MemoryItem>>` returns `this.repository.findByProjectMemory(query, page)`.
- In each of the four loops, change `this.repository.findByProject({ projectId, status: 'active', page, limit: PAGE_SIZE, …rest })` to `this.repository.findByProject({ projectId, status: 'active', …rest }, PageOption.from(page, PAGE_SIZE))`, and every `result.data` to `result.records`. Keep the `hasMore = result.records.length >= PAGE_SIZE` logic as it is. (M21, offset paging over rows the loop mutates, is out of scope here.)
- In `memory-governance.service.spec.ts`, change the mocked `findByProject` results from `{ data: [...], total, page, limit }` to `{ records: [...], total, current, size, hasNext, hasPrev }`, and change call assertions to the two-argument form, for example `expect(repo.findByProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', status: 'active' }), expect.objectContaining({ current: 1, size: 100 }))`.

Run: `cd apps/api && bunx jest src/memory/memory-governance.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Controller test (failing)**

In `apps/api/src/memory/memory-read.controller.spec.ts`, change **all ~20** handler calls (`grep -n "getMemory(" apps/api/src/memory/memory-read.controller.spec.ts`) from the old positional form `getMemory(slug, principal, kind, subject, status, page, limit, orderBy)` to the new signature `getMemory(slug, principal, rawQuery)`, where `rawQuery` is an object of strings, for example `{ kind: 'FACT', current: '2', size: '5' }` and replace the result/pagination assertions with:

```ts
  it('parses paging strings and forwards filters and page separately', async () => {
    governance.getProjectMemory.mockResolvedValue(new Page({ current: 2, size: 5 }, 0, []));

    await controller.getMemory('koda', principal, { current: '2', size: '5', kind: 'FACT' } as never);

    expect(governance.getProjectMemory).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1', kind: 'FACT' }),
      { current: 2, size: 5 },
    );
  });

  it('returns the six-field page envelope', async () => {
    governance.getProjectMemory.mockResolvedValue(new Page({ current: 1, size: 20 }, 1, [{ id: 'm1' }]));

    const res = await controller.getMemory('koda', principal, {} as never);

    expect(Object.keys(res.data).sort()).toEqual(['current', 'hasNext', 'hasPrev', 'records', 'size', 'total']);
    expect(res.data.records).toEqual([{ id: 'm1' }]);
  });
```

Use the spec's existing names for the mocked governance service, the principal and the project id. Delete tests for the removed `parseIntParam` and for the `MAX_LIMIT` slice.

Run: `cd apps/api && bunx jest src/memory/memory-read.controller.spec.ts`
Expected: FAIL

- [ ] **Step 7: Implement the controller**

Replace the body of `apps/api/src/memory/memory-read.controller.ts` below the constructor with:

```ts
  @Get()
  @ApiOperation({ summary: 'Get project memory items (paginated)' })
  @ApiResponse({ status: 200, description: 'Page of memory items: { total, current, size, hasNext, hasPrev, records }' })
  @ApiResponse({ status: 400, description: 'Invalid filter or paging parameter' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  @ApiResponse({ status: 404, description: 'Project not found' })
  async getMemory(
    @Param('slug') slug: string,
    @Principal() principal: KodaPrincipal,
    @Query() rawQuery: ListMemoryQuery,
  ): Promise<JsonResponse<IPageResult<MemoryItem>>> {
    const projectId = await this.projectAccess.findProjectIdBySlug(slug);
    await this.projectAccess.assertProjectMembership(projectId, principal);

    const { current, size, ...filters } = parseQuery(ListMemoryQuery, rawQuery);
    const page = await this.governance.getProjectMemory({ projectId, ...filters }, { current, size });
    return JsonResponse.Ok(toPageResult(page)) as JsonResponse<IPageResult<MemoryItem>>;
  }
```

Delete `MemoryPageResult`, `parseIntParam`, and the `ValidationAppException` / `ProjectMemoryQuery` imports if they become unused. Add imports for `ListMemoryQuery`, `parseQuery`, `toPageResult`, and `IPageResult` (type) from `@nathapp/nestjs-data`.

- [ ] **Step 8: Context builder**

In `apps/api/src/context/context-builder.service.ts`:
- The `findByProjectMemory` call (lines 108-112) becomes `this.memoryItemRepository.findByProjectMemory({ projectId: query.projectId, orderBy: 'confidence' }, PageOption.from(1, MAX_SEMANTIC_MEMORY))`.
- Line 124 `semanticMemoryResult.items` becomes `semanticMemoryResult.records`.
- Import `PageOption` from `@nathapp/nestjs-common`.
- Find every mock first: `grep -rn "findByProjectMemory" apps/api/src/context apps/api/test/unit/context`. Expect hits in five specs: `src/context/context-builder.service.spec.ts` and `test/unit/context/context-builder.service{,.token-budget,.adversarial,.slo-adversarial}.spec.ts`. In each, change every `findByProjectMemory.mockResolvedValue({ items: X, total: N })` (and `mockResolvedValueOnce`) to `{ records: X, total: N, current: 1, size: 10, hasNext: false, hasPrev: false }`, and change any assertion on the call arguments to the two-argument form `(expect.objectContaining({ projectId, orderBy: 'confidence' }), expect.objectContaining({ current: 1, size: 10 }))`. Missing any one leaves `semanticMemoryResult.records` undefined and that suite throws.

Run: `cd apps/api && bun run test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/memory apps/api/src/context apps/api/test/unit/context
git commit -m "feat(api): paginate memory list with ListMemoryQuery; drop PaginatedResult (Track 1 Slice 3)"
```

---

### Task 4: Timeline keyset cursor with pushed-down `take` (M20)

**Files:**
- Create: `apps/api/src/memory/event-order.ts` (+ `.spec.ts`)
- Create: `apps/api/src/memory/timeline-cursor.ts` (+ `.spec.ts`)
- Create: `apps/api/test/integration/memory/timeline-pagination.integration.spec.ts`
- Modify: `apps/api/src/memory/prisma-timeline.repository.ts`, `apps/api/src/memory/prisma-timeline.repository.spec.ts`
- Modify: `apps/api/src/memory/timeline.service.ts`, `apps/api/src/memory/timeline.service.spec.ts`
- Modify: `apps/api/src/memory/timeline.controller.ts:43-50`, `apps/api/src/memory/timeline.controller.spec.ts`

**Interfaces:**
- Produces:
  - `compareEventsDesc(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number`: negative when `a` sorts first (newer, or same time and larger id)
  - `interface TimelineKey { createdAt: Date; id: string }`
  - `encodeTimelineCursor(key: TimelineKey): string`, `decodeTimelineCursor(cursor: string): TimelineKey | null`
  - `keysetWhere(where: Record<string, unknown>, cursor?: TimelineKey): Record<string, unknown>`
  - `interface KeysetPage { cursor?: TimelineKey; take: number }`
  - `PrismaTimelineRepository.findTicketEvents(where, page?: KeysetPage)`, same for `findAgentEvents` and `findDecisionEvents`. Without `page` they behave as today (unbounded), which `getTicketHistory` keeps using.
  - `TimelineResponse = { events: TimelineEvent[]; nextCursor?: string }` (no `total`)

- [ ] **Step 1: Ordering and cursor tests (failing)**

```ts
// apps/api/src/memory/event-order.spec.ts
import { compareEventsDesc } from './event-order';

const at = (iso: string, id: string) => ({ createdAt: new Date(iso), id });

describe('compareEventsDesc', () => {
  it('orders newer first', () => {
    const rows = [at('2026-01-01T00:00:00Z', 'a'), at('2026-01-02T00:00:00Z', 'b')];
    expect(rows.sort(compareEventsDesc).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('breaks a createdAt tie by id descending, by code unit', () => {
    const t = '2026-01-01T00:00:00.000Z';
    const rows = [at(t, 'c1'), at(t, 'c9'), at(t, 'ca')];
    expect(rows.sort(compareEventsDesc).map((r) => r.id)).toEqual(['ca', 'c9', 'c1']);
  });
});
```

```ts
// apps/api/src/memory/timeline-cursor.spec.ts
import { decodeTimelineCursor, encodeTimelineCursor, keysetWhere } from './timeline-cursor';

describe('timeline cursor', () => {
  const key = { createdAt: new Date('2026-03-04T05:06:07.089Z'), id: 'ckabc123' };

  it('round-trips', () => {
    expect(decodeTimelineCursor(encodeTimelineCursor(key))).toEqual(key);
  });

  it.each([
    ['', 'empty'],
    ['ckabc123', 'an old-style bare event id'],
    ['not base64 !!', 'garbage'],
    [Buffer.from('2026-99-99T00:00:00Z|x').toString('base64url'), 'an invalid date'],
    [Buffer.from('2026-01-01T00:00:00.000Z|').toString('base64url'), 'an empty id'],
  ])('rejects %s (%s)', (cursor) => {
    expect(decodeTimelineCursor(cursor)).toBeNull();
  });

  it('ANDs the keyset condition with the existing where, keeping a createdAt range', () => {
    const where = { projectId: 'p1', createdAt: { gte: new Date('2026-01-01T00:00:00Z') } };
    expect(keysetWhere(where, key)).toEqual({
      AND: [
        where,
        { OR: [{ createdAt: { lt: key.createdAt } }, { createdAt: key.createdAt, id: { lt: key.id } }] },
      ],
    });
  });

  it('returns the where unchanged without a cursor', () => {
    const where = { projectId: 'p1' };
    expect(keysetWhere(where, undefined)).toBe(where);
  });
});
```

Run: `cd apps/api && bunx jest src/memory/event-order.spec.ts src/memory/timeline-cursor.spec.ts`
Expected: FAIL with `Cannot find module`

- [ ] **Step 2: Implement both modules**

```ts
// apps/api/src/memory/event-order.ts
interface Ordered {
  createdAt: Date;
  id: string;
}

/**
 * Newest first; ties broken by id descending. Ids compare by code unit so the
 * in-memory merge agrees with Postgres `ORDER BY "createdAt" DESC, id DESC`
 * for cuids (lowercase alphanumeric).
 */
export function compareEventsDesc(a: Ordered, b: Ordered): number {
  const timeDelta = b.createdAt.getTime() - a.createdAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  if (a.id === b.id) return 0;
  return a.id > b.id ? -1 : 1;
}
```

```ts
// apps/api/src/memory/timeline-cursor.ts
export interface TimelineKey {
  createdAt: Date;
  id: string;
}

const SEPARATOR = '|';
// Anchored ISO-8601 UTC timestamp as produced by Date#toISOString().
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function encodeTimelineCursor(key: TimelineKey): string {
  return Buffer.from(`${key.createdAt.toISOString()}${SEPARATOR}${key.id}`, 'utf8').toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeTimelineCursor(cursor: string): TimelineKey | null {
  if (!cursor) return null;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const at = decoded.indexOf(SEPARATOR);
  if (at < 0) return null;
  const iso = decoded.slice(0, at);
  const id = decoded.slice(at + 1);
  if (!ISO_UTC.test(iso) || id.length === 0) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, id };
}

/** `where AND (createdAt, id) < cursor`, without clobbering a createdAt range in `where`. */
export function keysetWhere(
  where: Record<string, unknown>,
  cursor: TimelineKey | undefined,
): Record<string, unknown> {
  if (!cursor) return where;
  return {
    AND: [
      where,
      { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] },
    ],
  };
}
```

Run: `cd apps/api && bunx jest src/memory/event-order.spec.ts src/memory/timeline-cursor.spec.ts`
Expected: PASS

- [ ] **Step 3: Repository tests (failing)**

In `apps/api/src/memory/prisma-timeline.repository.spec.ts`, keep the existing no-page tests (they pin `getTicketHistory`'s unbounded read) and add, for each of the three methods (shown for ticket events):

```ts
  it('pushes take and the keyset condition into findTicketEvents', async () => {
    const cursor = { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'ckb' };
    await repo.findTicketEvents({ projectId: 'p1' }, { cursor, take: 11 });

    expect(prisma.client.ticketEvent.findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          { projectId: 'p1' },
          { OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: 'ckb' } }] },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 11,
    });
  });
```

Use the spec's existing names for the repository and the mocked Prisma client. Repeat for `findAgentEvents` (`agentEvent`) and `findDecisionEvents` (`decisionEvent`).

Run: `cd apps/api && bunx jest src/memory/prisma-timeline.repository.spec.ts`
Expected: FAIL

- [ ] **Step 4: Implement the repository**

Replace the three methods in `apps/api/src/memory/prisma-timeline.repository.ts`:

```ts
export interface KeysetPage {
  cursor?: TimelineKey;
  take: number;
}

const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

  async findTicketEvents(where: Record<string, unknown>, page?: KeysetPage): Promise<TicketEventRow[]> {
    return this.prisma.client.ticketEvent.findMany({
      where: keysetWhere(where, page?.cursor),
      orderBy: NEWEST_FIRST,
      ...(page && { take: page.take }),
    });
  }
```

`findAgentEvents` and `findDecisionEvents` are identical apart from the model (`agentEvent`, `decisionEvent`) and the row type. Import `keysetWhere` and `TimelineKey` from `./timeline-cursor`. Place `KeysetPage` and `NEWEST_FIRST` at module level above the class.

Run: `cd apps/api && bunx jest src/memory/prisma-timeline.repository.spec.ts`
Expected: PASS. If a no-page test asserted the exact `findMany` argument, it still passes, because `keysetWhere` returns `where` unchanged and no `take` key is added.

- [ ] **Step 5: Service tests (failing)**

In `apps/api/src/memory/timeline.service.spec.ts`, update every mock repository result the service consumes. Remove assertions on `result.total`. Add:

```ts
  describe('keyset paging', () => {
    const t = (iso: string) => new Date(iso);

    it('asks each table for limit + 1 rows and returns an encoded nextCursor when more exist', async () => {
      repo.findTicketEvents.mockResolvedValue([
        { id: 'tk3', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-03T00:00:00.000Z') },
        { id: 'tk1', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-01T00:00:00.000Z') },
      ]);
      repo.findAgentEvents.mockResolvedValue([
        { id: 'ag2', actorId: 'u', action: 'a', createdAt: t('2026-01-02T00:00:00.000Z') },
      ]);
      repo.findDecisionEvents.mockResolvedValue([]);

      const result = await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(repo.findTicketEvents).toHaveBeenCalledWith(expect.anything(), { cursor: undefined, take: 3 });
      expect(result.events.map((e) => e.id)).toEqual(['tk3', 'ag2']);
      expect(decodeTimelineCursor(result.nextCursor!)).toEqual({ createdAt: t('2026-01-02T00:00:00.000Z'), id: 'ag2' });
      expect(result).not.toHaveProperty('total');
    });

    it('omits nextCursor on the last page', async () => {
      repo.findTicketEvents.mockResolvedValue([
        { id: 'tk1', actorId: 'u', action: 'a', ticketId: null, createdAt: t('2026-01-01T00:00:00.000Z') },
      ]);
      repo.findAgentEvents.mockResolvedValue([]);
      repo.findDecisionEvents.mockResolvedValue([]);

      const result = await service.getProjectTimeline({ projectId: 'p1', limit: 2 });

      expect(result.nextCursor).toBeUndefined();
    });

    it('decodes the cursor and forwards it to every table', async () => {
      repo.findTicketEvents.mockResolvedValue([]);
      repo.findAgentEvents.mockResolvedValue([]);
      repo.findDecisionEvents.mockResolvedValue([]);
      const key = { createdAt: t('2026-01-02T00:00:00.000Z'), id: 'ag2' };

      await service.getProjectTimeline({ projectId: 'p1', limit: 5, cursor: encodeTimelineCursor(key) });

      for (const fn of [repo.findTicketEvents, repo.findAgentEvents, repo.findDecisionEvents]) {
        expect(fn).toHaveBeenCalledWith(expect.anything(), { cursor: key, take: 6 });
      }
    });

    it.each(['garbage', 'ckold123'])('rejects an undecodable cursor %s with a validation error', async (cursor) => {
      await expect(service.getProjectTimeline({ projectId: 'p1', cursor })).rejects.toThrow(ValidationAppException);
      expect(repo.findTicketEvents).not.toHaveBeenCalled();
    });
  });
```

Imports: `encodeTimelineCursor`, `decodeTimelineCursor` from `./timeline-cursor`; `ValidationAppException` from `@nathapp/nestjs-common`. Use the spec's existing names for the service and the mocked repository, and reset mocks in `beforeEach`.

Run: `cd apps/api && bunx jest src/memory/timeline.service.spec.ts`
Expected: FAIL

- [ ] **Step 6: Implement the service**

In `apps/api/src/memory/timeline.service.ts`:
- Remove `total?: number` from `TimelineResponse`.
- Replace the body of `getProjectTimeline` from `const limit = …` down to the `return` with:

```ts
    const limit = query.limit ?? DEFAULT_TIMELINE_LIMIT;
    const eventTypes = query.eventTypes?.length ? query.eventTypes : [...TIMELINE_EVENT_TYPES];

    const unknownTypes = eventTypes.filter((eventType) => !TIMELINE_EVENT_TYPES.includes(eventType as TimelineEventType));
    if (unknownTypes.length > 0) {
      throw new ValidationAppException({ eventTypes: `Unknown event types: ${unknownTypes.join(', ')}` });
    }

    let cursor: TimelineKey | undefined;
    if (query.cursor !== undefined) {
      const decoded = decodeTimelineCursor(query.cursor);
      if (!decoded) {
        throw new ValidationAppException({ cursor: 'Invalid cursor' });
      }
      cursor = decoded;
    }

    // …keep the existing baseWhere / actorWhere / ticketWhere / decisionWhere construction unchanged…

    // Each table returns at most limit + 1 rows past the cursor; the merged
    // top `limit` is exact because every table is individually sorted the same way.
    const page = { cursor, take: limit + 1 };
    const results: TimelineEvent[] = [];

    if (eventTypes.includes('ticket_event')) {
      const rows = (await this.timelineRepo.findTicketEvents(ticketWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id, eventType: 'ticket_event', actorId: e.actorId, action: e.action,
        ticketId: e.ticketId ?? undefined, createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('agent_event')) {
      const rows = (await this.timelineRepo.findAgentEvents(actorWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id, eventType: 'agent_event', actorId: e.actorId, action: e.action, createdAt: e.createdAt,
      })));
    }

    if (!query.ticketId && eventTypes.includes('decision_event')) {
      const rows = (await this.timelineRepo.findDecisionEvents(decisionWhere, page)) ?? [];
      results.push(...rows.map((e) => ({
        id: e.id, eventType: 'decision_event', actorId: e.agentId, action: e.action, createdAt: e.createdAt,
      })));
    }

    results.sort(compareEventsDesc);
    const events = results.slice(0, limit);
    const last = events[events.length - 1];

    return {
      events,
      nextCursor: results.length > limit && last ? encodeTimelineCursor(last) : undefined,
    };
```

Module-level constants above the class:

```ts
export const DEFAULT_TIMELINE_LIMIT = 50;
export const MAX_TIMELINE_LIMIT = 100;
const TIMELINE_EVENT_TYPES = ['ticket_event', 'agent_event', 'decision_event'] as const;
type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];
```

Imports: `compareEventsDesc` from `./event-order`; `decodeTimelineCursor`, `encodeTimelineCursor`, `TimelineKey` from `./timeline-cursor`. Keep the existing sequential `await`s (do not switch to `Promise.all`; that is outside this slice). `getTicketHistory` is unchanged (it calls `findTicketEvents({ ticketId })` with no page).

Run: `cd apps/api && bunx jest src/memory/timeline.service.spec.ts`
Expected: PASS

- [ ] **Step 7: Strict `limit` in the controller (test first)**

In `apps/api/src/memory/timeline.controller.spec.ts`, add (using the spec's existing call shape for `getTimeline`, whose positional args are `slug, principal, actorId, ticketId, eventTypes, from, to, limit, cursor`):

```ts
    it.each(['0', '101', '-1', '10abc', '2.5'])('rejects limit=%s with a validation error', async (limit) => {
      await expect(
        controller.getTimeline('koda', principal, undefined, undefined, undefined, undefined, undefined, limit, undefined),
      ).rejects.toThrow(ValidationAppException);
      expect(mockTimelineService.getProjectTimeline).not.toHaveBeenCalled();
    });

    it('passes limit=100 through as a number', async () => {
      mockTimelineService.getProjectTimeline.mockResolvedValue(makeTimelineResponse());
      await controller.getTimeline('koda', principal, undefined, undefined, undefined, undefined, undefined, '100', undefined);
      expect(mockTimelineService.getProjectTimeline).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });
```

Remove `total` from the spec's `makeTimelineResponse()` helper if it sets one.

Run: `cd apps/api && bunx jest src/memory/timeline.controller.spec.ts`
Expected: FAIL (`'10abc'` currently parses to 10, and `'101'` is accepted)

Then replace `parseLimit` in `timeline.controller.ts` with:

```ts
  private parseLimit(value?: string): number | undefined {
    if (value === undefined || value === '') return undefined;
    const parsed = /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TIMELINE_LIMIT) {
      throw new ValidationAppException({ limit: `limit must be an integer between 1 and ${MAX_TIMELINE_LIMIT}` });
    }
    return parsed;
  }
```

Import `MAX_TIMELINE_LIMIT` from `./timeline.service`.

Run: `cd apps/api && bunx jest src/memory`
Expected: PASS

- [ ] **Step 8: Integration test: three tables, interleaved, with a tie**

```ts
// apps/api/test/integration/memory/timeline-pagination.integration.spec.ts
/**
 * Slice 3 / M20 — the timeline pages across ticket, agent and decision events
 * with a (createdAt, id) keyset; every event appears exactly once.
 * Run: cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bunx jest test/integration/memory/timeline-pagination
 */
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { PrismaTimelineRepository } from '../../../src/memory/prisma-timeline.repository';
import { TimelineService } from '../../../src/memory/timeline.service';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('timeline keyset pagination (PG)', () => {
  let prisma: PrismaService<PrismaClient>;
  let service: TimelineService;
  let projectId: string;
  // Newest first, as the API must return them. Ids are lowercase alphanumeric
  // (no '-' / '_': glibc collations ignore punctuation, which would make the
  // database order disagree with code-unit order).
  const expected: string[] = [];

  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute, 0, 0));
  const TIE = at(30);

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaService({ client: PrismaClient, clientOptions: { datasources: { db: { url: DATABASE_URL } } } });
    await prisma.onModuleInit();
    service = new TimelineService(new PrismaTimelineRepository(prisma));

    const project = await prisma.client.project.create({ data: { name: 'TL', slug: 'tl', key: 'TL' } });
    projectId = project.id;

    // Interleave the three tables minute by minute: minute m goes to table m % 3.
    const seeded: Array<{ id: string; createdAt: Date }> = [];
    for (let m = 0; m < 12; m++) {
      const id = `ev${String(m).padStart(2, '0')}`;
      const createdAt = at(m);
      if (m % 3 === 0) {
        await prisma.client.ticketEvent.create({ data: { id, projectId, action: 'x', actorId: 'u1', actorType: 'user', source: 'api', createdAt } });
      } else if (m % 3 === 1) {
        await prisma.client.agentEvent.create({ data: { id, projectId, agentId: 'a1', action: 'x', actorId: 'a1', source: 'api', createdAt } });
      } else {
        await prisma.client.decisionEvent.create({ data: { id, projectId, agentId: 'a1', action: 'x', decision: 'decided', source: 'api', createdAt } });
      }
      seeded.push({ id, createdAt });
    }
    // Same-createdAt tie spread across all three tables; order is decided by id.
    await prisma.client.ticketEvent.create({ data: { id: 'tieb', projectId, action: 'x', actorId: 'u1', actorType: 'user', source: 'api', createdAt: TIE } });
    await prisma.client.agentEvent.create({ data: { id: 'tiea', projectId, agentId: 'a1', action: 'x', actorId: 'a1', source: 'api', createdAt: TIE } });
    await prisma.client.decisionEvent.create({ data: { id: 'tiec', projectId, agentId: 'a1', action: 'x', decision: 'decided', source: 'api', createdAt: TIE } });
    seeded.push({ id: 'tieb', createdAt: TIE }, { id: 'tiea', createdAt: TIE }, { id: 'tiec', createdAt: TIE });

    seeded
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id > b.id ? -1 : 1))
      .forEach((e) => expected.push(e.id));
  });

  afterAll(async () => {
    await prisma.client.$disconnect();
  });

  async function walk(limit: number, extra: { from?: Date; to?: Date } = {}): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await service.getProjectTimeline({ projectId, limit, cursor, ...extra });
      seen.push(...page.events.map((e) => e.id));
      if (!page.nextCursor) return seen;
      cursor = page.nextCursor;
    }
    throw new Error('pagination did not terminate');
  }

  it.each([1, 2, 4, 15, 100])('returns every event exactly once in order with limit=%i', async (limit) => {
    expect(await walk(limit)).toEqual(expected);
  });

  it('keeps the tie ordered by id across tables', async () => {
    const ids = await walk(2);
    expect(ids.indexOf('tiec')).toBeLessThan(ids.indexOf('tieb'));
    expect(ids.indexOf('tieb')).toBeLessThan(ids.indexOf('tiea'));
  });

  it('honours a from/to window while paging', async () => {
    const from = at(3);
    const to = at(8);
    const inWindow = expected.filter((id) => /^ev\d+$/.test(id) && Number(id.slice(2)) >= 3 && Number(id.slice(2)) <= 8);
    expect(await walk(2, { from, to })).toEqual(inWindow);
  });
});
```

Run: `cd apps/api && KODA_DB_TESTS=1 bunx jest test/integration/memory/timeline-pagination`
Expected: PASS (7 tests)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/memory apps/api/test/integration/memory/timeline-pagination.integration.spec.ts
git commit -m "feat(api): timeline keyset cursor with pushed-down take (M20, Track 1 Slice 3)"
```

---

### Task 5: `/context` event read with pushed-down `take` (M20)

**Files:**
- Modify: `apps/api/src/memory/canonical-state.service.ts:8-13`
- Modify: `apps/api/src/memory/prisma-canonical-state.repository.ts:50-127`, `apps/api/src/memory/prisma-canonical-state.repository.spec.ts`
- Modify: `apps/api/src/context/context-builder.service.ts:102-107`, `apps/api/src/context/context-builder.service.spec.ts`

**Interfaces:**
- Consumes: `compareEventsDesc` (Task 4).
- Produces: `CanonicalSnapshotQuery.eventLimit?: number`; `DEFAULT_CANONICAL_EVENT_LIMIT = 20` exported from `prisma-canonical-state.repository.ts`. `findEvents` returns at most `eventLimit` events, newest first.

`policy-gate.service.ts:477` calls `getSnapshot({ projectId, ticketIds })` with no time window and no actor, so `findEvents` returns `[]` early for it. That path is unchanged.

- [ ] **Step 1: Repository test (failing)**

In `apps/api/src/memory/prisma-canonical-state.repository.spec.ts`, add:

```ts
  it('pushes take into all three event tables and returns the newest eventLimit overall', async () => {
    const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
    prisma.client.ticketEvent.findMany.mockResolvedValue([
      { id: 't3', actorId: 'u', action: 'a', data: '{}', createdAt: t(3) },
      { id: 't1', actorId: 'u', action: 'a', data: '{}', createdAt: t(1) },
    ]);
    prisma.client.agentEvent.findMany.mockResolvedValue([
      { id: 'a2', actorId: 'u', action: 'a', data: '{}', createdAt: t(2) },
    ]);
    prisma.client.decisionEvent.findMany.mockResolvedValue([
      { id: 'd4', agentId: 'u', action: 'a', data: '{}', rationale: null, createdAt: t(4) },
    ]);

    const events = await repo.findEvents({ projectId: 'p1', timeWindow: { from: new Date(0) }, eventLimit: 2 });

    for (const model of ['ticketEvent', 'agentEvent', 'decisionEvent'] as const) {
      expect(prisma.client[model].findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    }
    expect(events.map((e) => e.id)).toEqual(['d4', 't3']);
  });

  it('defaults eventLimit to 20', async () => {
    prisma.client.ticketEvent.findMany.mockResolvedValue([]);
    prisma.client.agentEvent.findMany.mockResolvedValue([]);
    prisma.client.decisionEvent.findMany.mockResolvedValue([]);

    await repo.findEvents({ projectId: 'p1', actorId: 'u' });

    expect(prisma.client.ticketEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20 }));
  });
```

Use the spec's existing names for the repository and the mocked client.

Run: `cd apps/api && bunx jest src/memory/prisma-canonical-state.repository.spec.ts`
Expected: FAIL (no `take`, and 4 events are returned)

- [ ] **Step 2: Implement**

In `canonical-state.service.ts`, add to `CanonicalSnapshotQuery`:

```ts
  /** Max events returned by findEvents across all three tables (default 20). */
  eventLimit?: number;
```

In `prisma-canonical-state.repository.ts`:
- Export `export const DEFAULT_CANONICAL_EVENT_LIMIT = 20;` above the class.
- In `findEvents`, compute `const take = query.eventLimit ?? DEFAULT_CANONICAL_EVENT_LIMIT;` and add `take` to each of the three `findMany` calls.
- Replace the final `events.sort(...)` block and `return events;` with:

```ts
    events.sort(compareEventsDesc);
    return events.slice(0, take);
```

Import `compareEventsDesc` from `./event-order`.

In `context-builder.service.ts`, add `eventLimit: MAX_RECENT_EVENTS,` to the `getSnapshot({ … })` argument (lines 102-107). In `context-builder.service.spec.ts`, add a test that `canonicalStateService.getSnapshot` is called with `expect.objectContaining({ eventLimit: 20 })`.

Run: `cd apps/api && bunx jest src/memory src/context test/unit/context`
Expected: PASS

- [ ] **Step 3: Full API gate and commit**

Run: `cd apps/api && bun run test && bunx tsc --noEmit -p tsconfig.json && bun run lint`
Expected: PASS

Run: `cd apps/api && KODA_DB_TESTS=1 bun run test:integration`
Expected: PASS. The existing `test/integration/context/context-controller.integration.spec.ts` must still pass unchanged.

```bash
git add apps/api/src/memory apps/api/src/context
git commit -m "feat(api): bound /context event reads with a pushed-down take (M20)"
```

---

### Task 6: OpenAPI regeneration and CLI

**Files:**
- Regenerate: `openapi.json`, `apps/cli/src/generated/**`
- Modify: `apps/cli/src/commands/ticket.ts:114-185`, `apps/cli/src/commands/ticket.spec.ts` (18 `data: { items` mocks throughout the file, plus the `--limit`/`--page` tests at ~line 690-730), `apps/cli/src/commands/ticket-us003.spec.ts:103-106`
- Modify: `apps/cli/src/commands/memory.ts:26-66`, `apps/cli/src/commands/memory.spec.ts`

**Interfaces:**
- Consumes: the API contract from Tasks 2-4.
- Produces: `koda ticket list --page <n> --size <n>` (the `--limit` flag is removed). With `--json` it prints the `records` array (unchanged shape for scripts). In table mode it prints a `More: --page <n+1>` hint when `hasNext`. `koda memory timeline` prints the `events` and a `Next: --cursor <c>` hint.

- [ ] **Step 1: Regenerate and inspect**

Run from the repo root: `bun run generate`
Then: `grep -n "TicketsControllerFindAllData = " -A 20 apps/cli/src/generated/types.gen.ts`
Expected: the query type has `current?: number; size?: number; status?; type?; priority?; assignedTo?; unassigned?` and **no** `page` / `limit`. The `MemoryReadControllerGetMemoryData` query likewise has `current` / `size`. If the generator emits `current` / `size` as `string`, pass `String(n)` in Step 3 instead of numbers.

Run: `python3 -c "import json;d=json.load(open('openapi.json'));print([p['name'] for p in d['paths']['/api/projects/{slug}/tickets']['get']['parameters']])"`
Expected: contains `current` and `size`, not `page` / `limit`.

- [ ] **Step 2: CLI tests (failing)**

First list every call site: `grep -n "data: { items" apps/cli/src/commands/ticket.spec.ts apps/cli/src/commands/ticket-us003.spec.ts` (expect 18 hits in `ticket.spec.ts` and 1 in `ticket-us003.spec.ts`). Convert every hit, not just the tests shown below.

In `apps/cli/src/commands/ticket.spec.ts` and `ticket-us003.spec.ts`:
- Change every `ticketsControllerFindAll` mock result from `{ ret: 0, data: { items: X, total: N } }` to `{ ret: 0, data: { records: X, total: N, current: 1, size: 20, hasNext: false, hasPrev: false } }`.
- Replace the `--limit` test (~line 690-707) and the `--page` test with:

```ts
    it('sends --page and --size as current and size', async () => {
      (ticketsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { records: [], total: 0, current: 2, size: 10, hasNext: false, hasPrev: true },
      });
      const listCmd = program.commands.find((c) => c.name() === 'ticket')?.commands.find((c) => c.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'test-project', '--page', '2', '--size', '10']);

      expect(ticketsControllerFindAll).toHaveBeenCalledWith(
        expect.objectContaining({ query: expect.objectContaining({ current: 2, size: 10 }) }),
      );
    });

    it('prints a next-page hint when hasNext', async () => {
      (ticketsControllerFindAll as jest.Mock).mockResolvedValue({
        ret: 0,
        data: { records: [], total: 45, current: 1, size: 20, hasNext: true, hasPrev: false },
      });
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const listCmd = program.commands.find((c) => c.name() === 'ticket')?.commands.find((c) => c.name() === 'list');

      await listCmd?.parseAsync(['node', 'test', '--project', 'test-project']);

      expect(logSpy.mock.calls.flat().join('\n')).toContain('--page 2');
      logSpy.mockRestore();
    });
```

In `apps/cli/src/commands/memory.spec.ts`, change the timeline mock result to `{ ret: 0, data: { events: [{ id: 'e1', eventType: 'ticket_event', actorId: 'u-1', action: 'created', createdAt: '2026-01-01T00:00:00.000Z' }], nextCursor: 'abc' } }` and assert that `--json` output parses to an array containing `id: 'e1'`, and that table mode prints `--cursor abc`.

Follow each spec's existing `process.exit` / `console.log` mocking conventions.

Run: `cd apps/cli && bunx jest src/commands/ticket.spec.ts src/commands/memory.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement the CLI changes**

In `apps/cli/src/commands/ticket.ts`, `ticket list`:
- Replace the `--limit` / `--page` options with:

```ts
    .option('--page <number>', 'Page number (1-based)', '1')
    .option('--size <number>', 'Tickets per page (1-100)', '20')
```

- The request query becomes `{ status: options.status, type: options.type, priority: options.priority, assignedTo: options.assignedTo, unassigned: options.unassigned ? true : undefined, current: parseInt(options.page, 10), size: parseInt(options.size, 10) }`.
- Replace the two `unwrap` / `items` lines with:

```ts
        const page = unwrap<TicketPage>(response);
        const items = page.records ?? [];
```

- After `table(...)` in the non-JSON branch, add:

```ts
          if (page.hasNext) {
            console.log(`\nShowing page ${page.current} (${items.length} of ${page.total}). More: --page ${page.current + 1}`);
          }
```

- In `ticket mine`, use the same `unwrap<TicketPage>` / `page.records` lines (no hint needed).
- Near `TicketRow`, define:

```ts
interface TicketPage {
  records: TicketRow[];
  total: number;
  current: number;
  size: number;
  hasNext: boolean;
  hasPrev: boolean;
}
```

In `apps/cli/src/commands/memory.ts`, `memory timeline`: change the `--limit` help text to `'Maximum number of events to return (1-100, default: 50)'`, and replace the `unwrap` / `items` lines with:

```ts
        const timeline = unwrap<{ events?: Array<Record<string, unknown>>; nextCursor?: string }>(response);
        const items = timeline.events ?? [];
```

In table mode, change the first column to `String(e['eventType'] ?? e['action'] ?? '')` and, after `table(...)`, add `if (timeline.nextCursor) console.log(`\nNext: --cursor ${timeline.nextCursor}`);`.

Run: `cd apps/cli && bun run test && bunx tsc --noEmit -p tsconfig.json`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add openapi.json apps/cli/src
git commit -m "feat(cli): page/size for ticket list; timeline reads events and prints the next cursor"
```

---

### Task 7: Web clients

**Files:**
- Modify: `apps/web/pages/[project]/index.vue:27-40`, `apps/web/tests/pages/project-board.spec.ts`
- Modify: `apps/web/composables/useMemory.ts`, `apps/web/tests/composables/useMemory.spec.ts`, and `apps/web/tests/pages/memory.spec.ts` / `memory-mount.spec.ts` if they mock `{ items, total }`
- Modify: `apps/web/composables/useTimelineEvents.ts:18-23`

**Interfaces:**
- Consumes: the page envelope `{ total, current, size, hasNext, hasPrev, records }`.
- Produces: the board loads 100 tickets per request and shows a "load more" button while `hasNext`. The memory page sends `current`, reads `records`, and derives `hasMore` from `hasNext`.

- [ ] **Step 1: Memory composable tests (failing)**

In `apps/web/tests/composables/useMemory.spec.ts`:
- Change every mocked response `{ data: { items: X, total: N } }` to `{ data: { records: X, total: N, current: <page>, size: 20, hasNext: <bool>, hasPrev: <bool> } }`. In the AC8 load-more test, the first response has `hasNext: true` and the second `hasNext: false`.
- Where a test asserts the request query contains `page: '2'`, assert `current: '2'` instead.
- Add:

```ts
test('hasMore follows the server hasNext flag, not a length comparison', async () => {
  const fetchMock = jest.fn(() => Promise.resolve({ data: { records: [], total: 5, current: 1, size: 20, hasNext: true, hasPrev: false } }))
  // …wire fetchMock into the mocked useApi the same way the other tests do…
  const mem = useMemory('koda')
  await mem.loadMemory()
  expect(mem.hasMore.value).toBe(true)
})
```

Run: `cd apps/web && bunx jest tests/composables/useMemory.spec.ts`
Expected: FAIL

- [ ] **Step 2: Implement `useMemory`**

In `apps/web/composables/useMemory.ts`:
- Replace `MemoryResponse` with:

```ts
export interface MemoryResponse {
  records: MemoryItem[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}
```

- In `buildMemoryQuery`, `if (filters.page && filters.page > 1) query.current = String(filters.page)`.
- Add `const hasNext = ref(false)`, and change `const hasMore = computed(() => hasNext.value)`.
- In `loadMemory` on success: `const fetched = res.records ?? []`, keep the append/replace line, then `total.value = res.total ?? items.value.length` and `hasNext.value = res.hasNext ?? false`. On a failed non-append load, also set `hasNext.value = false`.

Run: `cd apps/web && bunx jest tests/composables/useMemory.spec.ts tests/pages/memory.spec.ts tests/pages/memory-mount.spec.ts`
Expected: PASS (update any `{ items, total }` mocks in the two page specs the same way)

- [ ] **Step 3: Board test (failing)**

In `apps/web/tests/pages/project-board.spec.ts`, add a describe block in the file's existing source-inspection style:

```ts
describe('Slice 3: board reads the page envelope and can load more', () => {
  test('reads records, not items', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('.records')
    expect(source).not.toMatch(/\.items\b/)
  })

  test('requests a sized page and offers load-more while hasNext', () => {
    const source = readFileSync(pagePath, 'utf-8')
    expect(source).toContain('size: BOARD_PAGE_SIZE')
    expect(source).toContain('hasNext')
    expect(source).toContain('loadMoreTickets')
  })
})
```

Run: `cd apps/web && bunx jest tests/pages/project-board.spec.ts`
Expected: FAIL

- [ ] **Step 4: Implement the board**

In `apps/web/pages/[project]/index.vue`, replace the `TicketPage` interface through the `tickets` computed (lines 27-39) with:

```ts
interface TicketPage {
  records: Ticket[]
  total: number
  current: number
  size: number
  hasNext: boolean
  hasPrev: boolean
}

const BOARD_PAGE_SIZE = 100

const { data: ticketsData, pending, error, refresh } = useAsyncData(
  `tickets-${slug}`,
  () => $api.get<TicketPage>(`/projects/${slug}/tickets`, { query: { size: BOARD_PAGE_SIZE } }),
)

// Pages after the first, appended by "load more"; cleared whenever page 1 reloads.
const moreTickets = ref<Ticket[]>([])
const lastPage = ref<TicketPage | null>(null)
const loadingMore = ref(false)

watch(ticketsData, () => {
  moreTickets.value = []
  lastPage.value = null
})

const tickets = computed(() => [...(ticketsData.value?.records ?? []), ...moreTickets.value])
const hasNext = computed(() => (lastPage.value ?? ticketsData.value)?.hasNext ?? false)

async function loadMoreTickets() {
  const current = (lastPage.value ?? ticketsData.value)?.current ?? 1
  loadingMore.value = true
  try {
    const next = await $api.get<TicketPage>(`/projects/${slug}/tickets`, {
      query: { current: current + 1, size: BOARD_PAGE_SIZE },
    })
    moreTickets.value = [...moreTickets.value, ...next.records]
    lastPage.value = next
  }
  finally {
    loadingMore.value = false
  }
}
```

In the template, directly after the `<TicketBoard … />` element, add:

```vue
    <div v-if="hasNext" class="flex justify-center">
      <Button variant="outline" :disabled="loadingMore" @click="loadMoreTickets">
        {{ loadingMore ? t('common.loading') : t('tickets.loadMore') }}
      </Button>
    </div>
```

Add `"loadMore": "Load more"` under `tickets` in `apps/web/i18n/locales/en.json` and `"loadMore": "加载更多"` in `zh.json`. Check that `common.loading` exists in both (the timeline page already uses it). Check how `$api.get` accepts a query by reading `apps/web/composables/useApi.ts` (`useMemory` already calls `$api.get(url, { query })`) and match it.

- [ ] **Step 5: Timeline type**

In `apps/web/composables/useTimelineEvents.ts`, delete `total?: number` from the response interface (line 22). Run `grep -rn "\.total" apps/web/composables/useTimelineEvents.ts apps/web/pages/\[project\]/timeline.vue` and expect no hits.

- [ ] **Step 6: Web gate and commit**

Run: `cd apps/web && bun run test && bunx nuxi typecheck`
Expected: jest PASS. `nuxi typecheck` is known to be red on `main` for an unrelated nuxt bump (see the Track 2 backlog). Compare its error list against `main` (`git stash; bunx nuxi typecheck > /tmp/…; git stash pop`), and introduce no **new** errors.

```bash
git add apps/web
git commit -m "feat(web): board and memory read the page envelope; board loads more on hasNext"
```

---

### Task 8: Docs and final verification

**Files:**
- Modify: `docs/architecture.md` (add a `#### Pagination` subsection at the end of `### API`, which starts at line 38 and ends before `### Web` at line 65)
- Modify: `docs/superpowers/specs/2026-09-25-track-1-foundations-design.md` (status line for Slice 3)
- Modify: any doc that still documents `ticket list --limit` (`grep -rn "\-\-limit" docs apps/cli/README* README.md`)

- [ ] **Step 1: Architecture doc**

Add to `docs/architecture.md`, at the end of the `### API` section (just before `### Web`):

```markdown
#### Pagination

List endpoints that page take `current` (1-based, default 1) and `size` (1-100, default 20) through a query DTO that extends `KodaPageQuery` (`apps/api/src/common/dto/koda-page.query.ts`), and return `{ total, current, size, hasNext, hasPrev, records }`. The global ValidationPipe does not transform, so controllers pass the raw query through `parseQuery()` and return `toPageResult(page)`. Paged today: tickets, memory.

The timeline (`GET /projects/:slug/timeline`) is the exception: an append-only feed merged from three tables, paged by an opaque `(createdAt, id)` keyset cursor (`limit` 1-100, response `{ events, nextCursor? }`). `/context` reads at most 20 recent events. Comments, labels, agents and links return plain arrays.
```

- [ ] **Step 2: Spec status and stale flags**

In the spec, next to the "Slice 3 — Pagination" heading, add a status line: `**Status:** implemented on feat/track1-pagination (M20 closed).` Update any doc that documents `--limit` for `ticket list` so it documents `--page` / `--size` instead.

- [ ] **Step 3: Whole-repo verification**

Run from the repo root:

```bash
bun run type-check
bun run lint
bun run test
cd apps/api && bun run test:db:up && KODA_DB_TESTS=1 bun run test:integration
```

Expected: all PASS (apart from the `apps/web` typecheck baseline noted in Task 7).

Then re-verify M20 against source:

```bash
grep -n "findMany" apps/api/src/memory/prisma-timeline.repository.ts apps/api/src/memory/prisma-canonical-state.repository.ts
grep -rn "PaginatedResult\|findTicketsByProject\|countTicketsByProject" apps/api/src apps/cli/src apps/web --include=*.ts --include=*.vue
```

Expected: every timeline `findMany` spreads `take` when a page is given, and every canonical-state event `findMany` has `take`. The second grep prints nothing.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: pagination conventions (Track 1 Slice 3)"
```

Do not push or open a PR. Report to the user and wait for approval.

---

## Out of scope (recorded, not fixed here)

- **`koda ticket mine` returns nothing:** it sends `assignedTo: 'self'`, and the API has never resolved `self` to the caller. This is pre-existing. The fix belongs with Slice 4 (users + membership), where the principal-to-user mapping lands.
- **M21:** offset paging inside `MemoryGovernanceService` over rows the loop itself mutates. The governance loops are ported to the new page type unchanged.
- **Code-intel `searchSymbols` `page`/`limit` and the KB document list `limit`:** not in the spec's endpoint table. They are left as they are and can be moved to `KodaPageQuery` when those endpoints are next touched.
- The `apps/api/test/e2e/tickets.e2e.spec.ts` pagination cases are empty placeholders (comments only) and stay that way.
