# SPEC: Permissions P2c — The Audit Entry Store and `GET /audit`

## Summary

This feature gives `apps/api` a durable audit log that later features write to:
- **The table.** A new `AuditEntry` model records one row per audited write: the permission key, the resource type and id, the project, the full action context (actor, on-behalf-of, origin, approval block, correlation id) and a short change summary.
- **The storage.** `PrismaAuditStorage` implements `IAuditStorage` from `@nathapp/nestjs-audit` (`~4.2.3`, already on this branch) over a new append-only `AuditEntry` repository. It is provided under the package's `AUDIT_STORAGE` token.
- **The recorder.** `AuditRecorder.record(input)` reads the current `ActionContext`, builds the entry, and writes it through the storage in the caller's open transaction, so the entry commits or rolls back with the domain write it describes.
- **The read route.** `GET /api/audit` lists entries newest first, filtered by key, actor, approver, project, resource and date, and needs the global key `audit.read`.

No domain write calls the recorder yet. The audit-core, audit-fleet and audit-integrations features wire it into the writers.

This is the third of seven features implementing phase P2 of `docs/superpowers/specs/2026-10-18-permission-approval-redesign-design.md` (§5 "Action context and audit"). The order (ruled 2026-10-24): context, context-guard, **audit-entry**, audit-core, audit-fleet, audit-integrations, web.

## Motivation

P2 records who acted and who approved on every write (design principle 5, gaps A/ENH-1 and C/ENH-1). The two features before this one built the context: every request, tool call and system run now carries an `ActionContext` (`permissions-p2-context`, PR #325), and a write with no context throws in dev and test (`permissions-p2-context-guard`, PR #327). Nothing stores that context yet:
- `src/action-context/action-context.ts` notes "An `AuditEntry` reads all five; nothing here writes one."
- `audit.read` is in the catalog but sits in `PENDING_SURFACE_KEYS` because no route declares it.
- The only actor records today are per-domain (`FleetActivity`, `TicketEvent`, `PendingAction`). None carries the approval block or the on-behalf-of principal.

The audit-core, audit-fleet and audit-integrations features need a recorder to call and a table to write to, and the web feature needs a route to read. This feature delivers those three things and nothing that depends on a specific writer.

**Rulings that bind this feature** (user, 2026-10-24):
- **P2 is seven features**, in order: context, context-guard, audit-entry, audit-core, audit-fleet, audit-integrations, web.
- **This feature's scope** is the `AuditEntry` table, Prisma `IAuditStorage` via `@nathapp/nestjs-audit`, `AuditRecorder` in the same transaction, and `GET /audit` with `audit.read`.
- **Keep the design approach.** The command layer writes `AuditEntry` in the domain write's transaction, and the context-less write rule applies. The package's `AuditInterceptor` and `@Audit` decorator are **not** used.
- **Dependency versions** (user, 2026-10-24): `@nathapp/nestjs-audit` at the latest version, with every other `@nathapp/nestjs-*` bumped to the latest version too (`~4.2.3`; `notify`, `notify-prisma`, `tenant` at `1.3.0`). This is committed on the branch before the run, and the api was verified to type-check, lint, pass its unit suite and boot.

## Design

### Designer's calls (not ruled by the user; change them in review if wrong)

- **The package's `AuditModule` is not imported.** `AuditModule` (4.2.3) eagerly builds `AuditInterceptor`, which needs the `CLOCK` token, and `RequestContextService`, none of which koda uses. Koda imports only the package's types (`IAuditStorage`, `AuditEntry`) and its `AUDIT_STORAGE` token, and its own module provides the storage under that token.
- **The koda module is `AuditLogModule`** (`src/audit/audit-log.module.ts`). The name avoids clashing with the package's `AuditModule`. The package's `AuditEntry` interface is imported as `PackageAuditEntry` (`import type { AuditEntry as PackageAuditEntry } from '@nathapp/nestjs-audit'`), because the generated Prisma model has the same name.
- **Koda's extra fields travel in `AuditEntry.metadata`.** The package entry has `action`, `actor`, `resource`, `resourceId`, `correlationId`, `timestamp` and `metadata`. The recorder puts `projectId`, `onBehalfOf`, `origin`, `approval` and `summary` into `metadata` as a `KodaAuditMetadata`, and the storage maps them to columns. `action` holds the permission key, and `resource` holds the resource type.
- **The storage implements `record` only.** `query` is optional in the package. `GET /api/audit` needs pagination plus approver and project filters, which `AuditQueryFilter` lacks, so the route reads through `AuditLogService.list` → the repository's `findPage`.
- **The recorder refuses to run outside a transaction.** `record` throws when `txManager.isInTransaction()` is false. "Same transaction" is the design's guarantee, and an entry written outside a transaction could survive a write that rolled back. Callers (from audit-core on) wrap the write and the record in one `txManager.run`.
- **An audit write that fails fails the domain write.** Both run in one transaction, so a storage error rolls the domain write back. The design's "an audit gap never becomes an outage" covers only the missing-context case (production records `SYSTEM/unknown`), not a failed insert.
- **The key must be a catalog key.** `record` throws for a key `findCatalogEntry` does not know, so a typo cannot produce an entry nobody can filter for.
- **The summary is a plain string, capped at 500 characters.** A longer summary is cut to its first 500 characters. A string keeps secrets out more easily than a JSON diff. What goes into it, and redacting it, is each writer's job in the later features (see Out of Scope).
- **No context means `SYSTEM/unknown`.** With no context current, the recorder writes actor `SYSTEM/unknown`, origin `system`, `NO_APPROVAL` and a new correlation id. In dev and test the context-guard's Prisma extension throws `ContextlessWriteError` on the `auditEntry.create` anyway. In production the row is written, matching the guard's `record` mode.
- **The repository is append-only.** `PrismaAuditEntryRepository` extends `AbstractPrismaRepository` as `.nax/rules/api-repositories.md` requires, and its `toPersistenceUpdate` throws `Error('audit entries are append-only')`, so the base `update` rejects. Nothing calls the base `delete`.
- **No foreign keys.** Like `FleetActivity`, the row stores `projectId`, actor and resource ids as plain strings. An audit row must outlive a deleted project, user or agent.
- **`audit.read` is global only.** The catalog already gives it scope `global` (`NEW_KEY_SCOPES`), and the role matrix snapshot grants it to `owner` and `admin` only. `PermissionService.can` with no `projectId` ignores project-role bindings, so a project role cannot reach the route, and it needs no per-project filtering by key.
- **Dates are UTC and inclusive at both ends.** `from` and `to` accept a date (`YYYY-MM-DD`) or a UTC instant ending in `Z`; anything else (an offset, an offset-less date-time, a word) is a 400 error. A date-only `from` means `00:00:00.000Z` of that day, and a date-only `to` means `23:59:59.999Z` of that day, so `from=2026-10-24&to=2026-10-24` is the whole day. `from` after `to` is a 400 error.

### The table (US-001)

`apps/api/prisma/schema.prisma` gains, with migration `prisma/migrations/20261103090000_audit_entry/migration.sql`:

```prisma
/// Permissions P2c: one row per audited write, written in the write's transaction. Append-only.
/// No foreign keys: an audit row outlives the project, user, agent or resource it names.
model AuditEntry {
  id                String   @id @default(cuid())
  key               String   // permission catalog key, e.g. ticket.create
  resourceType      String
  resourceId        String
  projectId         String?
  actorType         String   // USER | AGENT | RUNNER | SYSTEM
  actorId           String
  onBehalfOfType    String?  // USER | AGENT
  onBehalfOfId      String?
  origin            String   // rest | mcp | thread | runner | system
  requiredMode      String   // none | self | agent | human
  satisfiedBy       String   // none | self | agent | human
  approverType      String?  // USER | AGENT
  approverId        String?
  approvalRequestId String?
  correlationId     String
  summary           String?
  createdAt         DateTime @default(now())

  @@index([createdAt])
  @@index([projectId, createdAt])
  @@index([actorId, createdAt])
  @@index([actorType])
  @@index([approverId])
  @@index([key])
  @@index([resourceType, resourceId])
}
```

`src/audit/domain/audit-entry.domain.ts`:

```typescript
import type { IPageOption } from '@nathapp/nestjs-common';
import type { IPageResult } from '@nathapp/nestjs-data';
import type { ActionApproval, ActionActorType, ActionOrigin, ActorType } from '../../action-context/action-context';

export const AUDIT_ENTRY_REPOSITORY = Symbol('AUDIT_ENTRY_REPOSITORY');
export const AUDIT_SUMMARY_MAX = 500;

export interface AuditEntryRecord {
  id?: string;                     // absent on create; set by the database
  key: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  actorType: ActionActorType;
  actorId: string;
  onBehalfOfType: ActorType | null;
  onBehalfOfId: string | null;
  origin: ActionOrigin;
  requiredMode: ActionApproval['requiredMode'];
  satisfiedBy: ActionApproval['satisfiedBy'];
  approverType: ActorType | null;
  approverId: string | null;
  approvalRequestId: string | null;
  correlationId: string;
  summary: string | null;
  createdAt: Date;
}

export interface AuditEntryFilters {
  key?: string;
  actorType?: ActionActorType;
  actorId?: string;
  approverId?: string;
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
  from?: Date;   // inclusive
  to?: Date;     // inclusive
}

/** What AuditRecorder puts in the package entry's `metadata`, and PrismaAuditStorage reads back. */
export interface KodaAuditMetadata {
  projectId: string | null;
  onBehalfOf: { type: ActorType; id: string } | null;
  origin: ActionOrigin;
  approval: ActionApproval;
  summary: string | null;
}
```

`PrismaAuditEntryRepository` (`src/audit/prisma-audit-entry.repository.ts`):

```typescript
@Injectable()
export class PrismaAuditEntryRepository
  extends AbstractPrismaRepository<AuditEntryRecord, AuditEntryModel, string> {
  constructor(@Inject(TRANSACTION_MANAGER) tx: ITransactionManager, private readonly prisma: PrismaService) {
    super(tx);
  }
  protected modelDelegate(client: unknown) { return (client as Record<string, unknown>).auditEntry; }
  protected toDomain(m: AuditEntryModel): AuditEntryRecord;
  protected toPersistenceCreate(d: AuditEntryRecord);     // every column except id
  protected toPersistenceUpdate(): never;                 // throws Error('audit entries are append-only')
  /** Escape hatch: filtered page, ordered createdAt desc then id desc. */
  async findPage(filters: AuditEntryFilters, page: IPageOption): Promise<IPageResult<AuditEntryRecord>>;
}
```

- `findPage` uses `Paginate` from `@nathapp/nestjs-prisma` over `this.prisma.client.auditEntry`, as `PrismaFleetActivityRepository.findPage` does, with `from` mapped to `createdAt: { gte }` and `to` to `createdAt: { lte }`.
- The module binds `{ provide: AUDIT_ENTRY_REPOSITORY, useExisting: PrismaAuditEntryRepository }`. The storage depends on the token, and the service injects the concrete class for `findPage`. Neither is exported.

### The storage (US-002)

`PrismaAuditStorage implements IAuditStorage` (`src/audit/prisma-audit.storage.ts`). `record(entry)` validates, then calls the repository's `create` with:

| `AuditEntry` (package) | column |
|:--|:--|
| `action` | `key` |
| `resource` | `resourceType` |
| `resourceId` | `resourceId` |
| `actor.type`, `actor.id` | `actorType`, `actorId` |
| `correlationId` | `correlationId` |
| `timestamp` | `createdAt` |
| `metadata.projectId` | `projectId` |
| `metadata.onBehalfOf` | `onBehalfOfType`, `onBehalfOfId` (both null when absent) |
| `metadata.origin` | `origin` |
| `metadata.approval` | `requiredMode`, `satisfiedBy`, `approverType`, `approverId`, `approvalRequestId` (from `requestId`); each optional approval field null when absent |
| `metadata.summary` | `summary` |

Validation checks, in this order: `actor`, `actor.type`, `resource`, `resourceId`, `correlationId`, `metadata`, `metadata.origin`, `metadata.approval`. The first one missing throws `Error('audit entry is not a koda audit entry: <field>')`, and `create` is not called. `AuditLogModule` provides the storage as `{ provide: AUDIT_STORAGE, useExisting: PrismaAuditStorage }`. It imports nothing: `PrismaModule` (with `TRANSACTION_MANAGER`) and the permissions providers are global.

### The recorder (US-003, US-004)

`src/audit/audit-recorder.service.ts`:

```typescript
export interface AuditRecordInput {
  key: string;              // a PERMISSION_CATALOG key
  resourceType: string;
  resourceId: string;
  projectId?: string | null;
  summary?: string;
}

@Injectable()
export class AuditRecorder {
  constructor(
    @Inject(AUDIT_STORAGE) private readonly storage: IAuditStorage,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /** Call inside the domain write's txManager.run, so the entry commits or rolls back with it. */
  async record(input: AuditRecordInput): Promise<void>;
}
```

The order inside `record`:
1. When `findCatalogEntry(input.key)` is undefined, it throws `Error('unknown audit key: <key>')`.
2. When `txManager.isInTransaction()` is false, it throws `Error('AuditRecorder.record must run inside a transaction')`.
3. It reads `currentContext()`. With none, it uses actor `{ type: 'SYSTEM', id: 'unknown' }`, origin `system`, `NO_APPROVAL`, no on-behalf-of and a new `randomUUID()` correlation id.
4. It cuts `summary` to its first `AUDIT_SUMMARY_MAX` UTF-16 code units (`summary.slice(0, AUDIT_SUMMARY_MAX)`).
5. It calls `storage.record({ action: key, actor: { id, type }, resource: resourceType, resourceId, correlationId, timestamp: new Date(), metadata: KodaAuditMetadata })`. The storage's rejection propagates unchanged.

Steps 1 and 2 run before anything is written, so a refused call writes nothing. `AuditLogModule` exports `AuditRecorder` (US-003) and `AuditLogService` (US-005): services only, per `.nax/rules/api-data.md`. `AppModule` imports `AuditLogModule` (US-003).

### The service and response DTO (US-005)

`AuditLogService` (`src/audit/audit-log.service.ts`):

```typescript
export interface AuditListQuery {
  key?: string; actorType?: ActionActorType; actorId?: string; approverId?: string;
  projectId?: string; resourceType?: string; resourceId?: string;
  from?: string;  // YYYY-MM-DD or a UTC instant ending in Z (validated by ListAuditQuery)
  to?: string;
}

@Injectable()
export class AuditLogService {
  constructor(private readonly repo: PrismaAuditEntryRepository) {}
  async list(query: AuditListQuery, page: IPageOption): Promise<IPageResult<AuditEntryDto>>;
}
```

- `list` turns `from` and `to` into `Date`s: a date-only `from` becomes `<date>T00:00:00.000Z`, a date-only `to` becomes `<date>T23:59:59.999Z`, and an instant is used as given.
- When both are given and `from` is after `to`, it throws `new ValidationAppException({ reason: 'from must not be after to' }, 'audit.auditQuery')` without calling `findPage`.
- Otherwise it returns `remapPage(await this.repo.findPage(filters, page), AuditEntryDto.from)`, passing the other filters through unchanged.

`AuditEntryDto` (`src/audit/dto/audit-entry.dto.ts`), every field with `@ApiProperty()` or `@ApiPropertyOptional({ nullable: true, … })` as `FleetActivityDto` does:

```typescript
export class AuditEntryDto {
  id: string;
  key: string;
  resourceType: string;
  resourceId: string;
  projectId: string | null;
  actor: { type: 'USER' | 'AGENT' | 'RUNNER' | 'SYSTEM'; id: string };
  onBehalfOf: { type: 'USER' | 'AGENT'; id: string } | null;   // null when onBehalfOfType is null
  origin: 'rest' | 'mcp' | 'thread' | 'runner' | 'system';
  approval: { requiredMode: string; satisfiedBy: string; approverType: 'USER' | 'AGENT' | null; approverId: string | null; requestId: string | null };
  correlationId: string;
  summary: string | null;
  createdAt: string; // ISO 8601, from Date.toISOString()
  static from(r: AuditEntryRecord): AuditEntryDto;
}
```

New i18n key `auditQuery` → `{ "-2": "Invalid audit query: {reason}" }` in `src/i18n/en/audit.json`, and `{ "-2": "无效的审计查询：{reason}" }` in `src/i18n/zh/audit.json`.

### The route (US-006)

`AuditController` (`src/audit/audit.controller.ts`):

```typescript
@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditLogService) {}

  @Get()
  @UseGuards(RequiresGuard)
  @Requires('audit.read')
  @ApiOperation({ summary: 'Audit entries, newest first; needs the global key audit.read' })
  @ApiResponse({ status: 200, description: 'Page of AuditEntryDto' })
  @ApiResponse({ status: 400, description: 'Invalid filter or date window' })
  @ApiResponse({ status: 403, description: 'Caller does not hold audit.read' })
  async list(@Query() rawQuery: ListAuditQuery) {
    const { current, size, ...query } = parseQuery(ListAuditQuery, rawQuery);
    return JsonResponse.Ok(toPageResult(await this.audit.list(query, { current, size })));
  }
}
```

- `ListAuditQuery extends KodaPageQuery` (`src/audit/dto/list-audit.query.ts`), every field `@ApiPropertyOptional()` and `@IsOptional()`:
  - `actorType`: `@IsIn(['USER', 'AGENT', 'RUNNER', 'SYSTEM'])`.
  - `key`, `actorId`, `approverId`, `projectId`, `resourceType`, `resourceId`: `@IsString() @MaxLength(128)`.
  - `from`, `to`: `@IsISO8601({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/, { message: 'use a date (YYYY-MM-DD) or a UTC instant ending in Z' })`. This is the same pattern as the unexported `UTC_INSTANT` in `src/fleet/analytics/dto/analytics-query.dto.ts`, written out here rather than imported.
- `audit.read` leaves `PENDING_SURFACE_KEYS` in `src/permissions/catalog.ts`, because a route now declares it.
- `openapi.json` is regenerated with `bun run api:export-spec` (repo root) and gains the `GET /api/audit` operation. The `@ApiResponse` has no `type`, as on `FleetActivityController`, so no `AuditEntryDto` component schema is required. Unrelated drift in the regenerated file is allowed. The regeneration runs in US-006, after the controller exists, because `spec-integrity.integration.spec.ts` reads the committed file.

### Failure Handling

| Situation | Behaviour | Story |
|:--|:--|:--|
| `PrismaAuditEntryRepository.update` called | rejects with `Error('audit entries are append-only')` | US-001 |
| `PrismaAuditStorage.record` given an entry missing a required field (including `actor.type`) | throws `Error('audit entry is not a koda audit entry: <field>')` for the first missing field in the validation order; `create` not called | US-002 |
| `AuditRecorder.record` with a key outside the catalog | throws `Error('unknown audit key: <key>')`; storage not called | US-004 |
| `AuditRecorder.record` outside a transaction | throws `Error('AuditRecorder.record must run inside a transaction')`; storage not called | US-004 |
| `AuditRecorder.record` with no context current | records actor `SYSTEM/unknown`, origin `system`, `NO_APPROVAL`; in dev/test the guard rejects the insert with `ContextlessWriteError` | US-004 |
| the storage rejects | the rejection propagates; the enclosing transaction rolls back | US-004 |
| the enclosing `txManager.run` throws after `record` | no `AuditEntry` row remains | US-004 |
| `AuditLogService.list` with `from` after `to` | `ValidationAppException` `audit.auditQuery`; repository not called | US-005 |
| `GET /api/audit` without `audit.read` | 403 | US-006 |
| `GET /api/audit` unauthenticated | 401 | US-006 |
| `from` or `to` not a date or a UTC instant ending in `Z` | 400 (validation pipe) | US-006 |
| `actorType` outside the four types | 400 (validation pipe) | US-006 |

### Integration

Verified at main `0c0a8ad8`, with `@nathapp/nestjs-*` at 4.2.3 on this branch. The baseline exists only to locate the code; it is never the interface to implement.

Read-only:
- `currentContext()`, `runWithActor`, `runAsSystem`, `runWithActionContext`, `NO_APPROVAL`, `ActionApproval`, `ActionActorType`, `ActionOrigin`, `ActorType` — `src/action-context/action-context.ts`.
- `findCatalogEntry(key): PermissionCatalogEntry | undefined` — `src/permissions/catalog.ts:435`.
- `ITransactionManager.isInTransaction(): boolean`, `TRANSACTION_MANAGER` — `@nathapp/nestjs-data`.
- `AbstractPrismaRepository<TDomain, TModel, TId>` (`create`, `update`, `findById`; abstract `modelDelegate`, `toDomain`, `toPersistenceCreate`, `toPersistenceUpdate`), `Paginate`, `PrismaService` — `@nathapp/nestjs-prisma`. Precedent: `src/webhook/prisma-webhook.repository.ts`.
- `IAuditStorage { record(entry): Promise<void>; query?(filter) }`, `AuditEntry`, `AUDIT_STORAGE = Symbol.for('AUDIT_STORAGE')` — `@nathapp/nestjs-audit` 4.2.3 (`dist/interface/*.d.ts`, `dist/constant/audit.constants.js`).
- `KodaPageQuery`, `parseQuery`, `toPageResult`, `remapPage` — `src/common/dto/koda-page.query.ts`.
- Pattern for the route: `src/fleet/activity/` (`FleetActivityController`, `FleetActivityDto`, `ListFleetActivityQuery`).
- `withTestActor(actor, fn)`, `fixtureDb(app)` — `test/helpers/action-context.ts`.
- `scratchSchemaBefore(baseUrl, schema, target)`, `applyMigration(db, migration)` — `test/helpers/migration-schema.ts`.
- `ContextlessWriteError` — `src/action-context/contextless-write.ts`, applied by `src/prisma/koda-prisma-client.ts`.

Changed (baseline → target):
- `PENDING_SURFACE_KEYS` — Baseline: includes `'audit.read'`. Target: does not.
- `AppModule` imports — Baseline: no audit module. Target: imports `AuditLogModule`.

## Out of Scope

- Calling `AuditRecorder.record` from any domain write, service, tool or system writer is out of scope (features `permissions-p2-audit-core`, `permissions-p2-audit-fleet` and `permissions-p2-audit-integrations`).
- Generalising `src/koda-domain-writer/` into the command layer that records audit entries is out of scope (feature `permissions-p2-audit-core`).
- Choosing what each writer puts in `summary`, and redacting secrets from it, is out of scope; each writer feature (audit-core, audit-fleet, audit-integrations) owns its summaries, and the recorder only caps the length.
- The runtime coverage guard (dev/test throw when a request, tool or system run commits a domain write with no `AuditEntry`) and the walker test over write surfaces are out of scope (feature `permissions-p2-audit-integrations`).
- The web Audit log page is out of scope (feature `permissions-p2-web`).
- Using the package's `AuditInterceptor`, `@Audit` decorator, `AuditModule`, `DefaultActorResolver` or `InMemoryAuditStorage` is out of scope (ruling: the command layer writes entries; designer's call: the module is not imported).
- Implementing `IAuditStorage.query` is out of scope (optional in the package; `GET /api/audit` reads through the repository).
- Retention or purging of `AuditEntry` rows is out of scope; rows are kept indefinitely until a later feature adds a retention policy.
- Deleting an `AuditEntry` row is out of scope; no code path calls the repository's `delete`.
- The base-class `findOne` and `count(criteria)` are unsupported on `PrismaAuditEntryRepository` (both route criteria through `toPersistenceUpdate`, which throws); reads go through `findById` and `findPage` only.
- A CLI `koda audit` command and regenerating `apps/cli/src/generated/` are out of scope.
- Granting `audit.read` to any project role, or scoping `GET /api/audit` per project by key, is out of scope (`audit.read` is a global key).
- Bumping `@nathapp/nestjs-*` and adding `@nathapp/nestjs-audit` is out of scope for the stories; it is already committed on the branch.
- Filtering by `onBehalfOfId`, `origin` or `correlationId` in `GET /api/audit` is out of scope (the design's filter list is actor, approver, key, project and date; resource is added for the web page's per-resource view).
- An `AuditEntryDto` component schema in `openapi.json` is out of scope (the route's `@ApiResponse` carries no `type`, as on `FleetActivityController`).
- US-006 only: rate limiting `GET /api/audit` beyond the app's global throttler is out of scope (a global-admin read route, same as `GET /api/fleet/activity`).

## Stories

1. **US-001: The `AuditEntry` table and its append-only repository** — `Workdir: apps/api` — No dependencies. The model and migration (then `bun run db:generate`, since `src/generated/prisma/` is gitignored), and `PrismaAuditEntryRepository` (`create`, `findPage` with every filter, `update` refused).
2. **US-002: `PrismaAuditStorage` and `AuditLogModule`** — `Workdir: apps/api` — Depends on US-001. The storage's mapping and validation, and the module binding `AUDIT_ENTRY_REPOSITORY` and `AUDIT_STORAGE`.
3. **US-003: `AuditRecorder` writes the current context** — `Workdir: apps/api` — Depends on US-002. The recorder's mapping from `ActionContext` and input to the package entry; `AuditLogModule` exports it and `AppModule` imports the module.
4. **US-004: `AuditRecorder` refusals and rollback** — `Workdir: apps/api` — Depends on US-003. The no-context fallback, the unknown-key and no-transaction refusals, and rollback with the enclosing transaction.
5. **US-005: `AuditLogService.list` and `AuditEntryDto`** — `Workdir: apps/api` — Depends on US-002. The date-window conversion and refusal, the filter pass-through and the DTO mapping, plus the i18n key.
6. **US-006: `GET /api/audit` for holders of `audit.read`** — `Workdir: apps/api` — Depends on US-003, US-005. Controller, query DTO and validation, `audit.read` out of `PENDING_SURFACE_KEYS`, endpoint e2e coverage and the regenerated `openapi.json`.

### Context Files

**US-001**
- `apps/api/prisma/schema.prisma`
- `apps/api/src/webhook/prisma-webhook.repository.ts`
- `apps/api/src/fleet/activity/prisma-fleet-activity.repository.ts`
- `apps/api/src/action-context/action-context.ts`
- `apps/api/test/helpers/migration-schema.ts`

**US-002**
- `apps/api/src/audit/domain/audit-entry.domain.ts` — created by US-001
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — created by US-001
- `apps/api/src/fleet/activity/fleet-activity.module.ts`

**US-003**
- `apps/api/src/audit/audit-log.module.ts` — created by US-002, extended here
- `apps/api/src/audit/domain/audit-entry.domain.ts` — created by US-001
- `apps/api/src/action-context/action-context.ts`
- `apps/api/src/permissions/catalog.ts`
- `apps/api/test/helpers/action-context.ts`

**US-004**
- `apps/api/src/audit/audit-recorder.service.ts` — created by US-003, extended here
- `apps/api/src/action-context/contextless-write.ts`
- `apps/api/test/helpers/action-context.ts`

**US-005**
- `apps/api/src/audit/audit-log.module.ts` — created by US-002, extended here
- `apps/api/src/audit/prisma-audit-entry.repository.ts` — created by US-001
- `apps/api/src/fleet/activity/dto/fleet-activity.dto.ts`
- `apps/api/src/fleet/analytics/analytics-window.ts`
- `apps/api/src/i18n/en/fleet.json`

**US-006**
- `apps/api/src/fleet/activity/fleet-activity.controller.ts`
- `apps/api/src/fleet/activity/dto/list-fleet-activity.query.ts`
- `apps/api/src/audit/audit-log.service.ts` — created by US-005
- `apps/api/src/audit/audit-log.module.ts` — created by US-002, extended here with the controller
- `apps/api/src/audit/audit-recorder.service.ts` — created by US-003, used by the route's integration fixtures

### Creates

**US-001**
- `apps/api/prisma/migrations/20261103090000_audit_entry/migration.sql`
- `apps/api/src/audit/domain/audit-entry.domain.ts`
- `apps/api/src/audit/prisma-audit-entry.repository.ts`
- `apps/api/test/integration/audit/audit-entry.repository.integration.spec.ts`
- `apps/api/test/integration/audit/audit-entry.migration.integration.spec.ts`

**US-002**
- `apps/api/src/audit/prisma-audit.storage.ts`
- `apps/api/src/audit/prisma-audit.storage.spec.ts`
- `apps/api/src/audit/audit-log.module.ts`
- `apps/api/src/audit/audit-log.module.spec.ts`

**US-003**
- `apps/api/src/audit/audit-recorder.service.ts`
- `apps/api/src/audit/audit-recorder.service.spec.ts`
- `apps/api/test/integration/audit/audit-recorder.integration.spec.ts`

**US-004**
- `apps/api/src/audit/audit-recorder.refusals.spec.ts`
- `apps/api/test/integration/audit/audit-recorder.rollback.integration.spec.ts`

**US-005**
- `apps/api/src/audit/audit-log.service.ts`
- `apps/api/src/audit/audit-log.service.spec.ts`
- `apps/api/src/audit/dto/audit-entry.dto.ts`
- `apps/api/src/audit/dto/audit-entry.dto.spec.ts`
- `apps/api/src/i18n/en/audit.json`
- `apps/api/src/i18n/zh/audit.json`

**US-006**
- `apps/api/src/audit/audit.controller.ts`
- `apps/api/src/audit/dto/list-audit.query.ts`
- `apps/api/test/integration/audit/audit-route.integration.spec.ts`

### Modifies

**US-001**
- `apps/api/prisma/schema.prisma` — gains the AuditEntry model with its seven indexes; no existing model changes.

**US-002**
None. The story only creates files; no existing assertion pins their absence.

**US-003**
- `apps/api/src/app.module.ts` — imports AuditLogModule; no other import changes, and no existing assertion lists the AppModule imports.

**US-004**
None. The story extends audit-recorder.service.ts, which US-003 creates in this feature (listed under Context Files); no pre-existing assertion changes.

**US-005**
None. The story creates its files and extends audit-log.module.ts, which US-002 creates in this feature (listed under Context Files).

**US-006**
- `apps/api/src/permissions/catalog.ts` — removes 'audit.read' from PENDING_SURFACE_KEYS, because GET /api/audit now declares it; no other key changes.
- `apps/api/src/permissions/test-helpers/permission-contract.spec.ts` — its expectedPending set lists 'audit.read'; it drops that entry, and the assertion that PENDING_SURFACE_KEYS equals expectedPending is kept.
- `apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts` — gains a GET /api/audit block (200 with the suite's admin token), as the api-testing rule requires for a new endpoint; existing blocks keep their expectations.
- `apps/api/test/integration/openapi-spec/spec-integrity.integration.spec.ts` — its expected-endpoint list gains the entry with path '/api/audit' and method 'get'; the existing entries and the decorator checks are unchanged.
- `openapi.json` — regenerated with bun run api:export-spec (repo root) so it gains the GET /api/audit operation; unrelated drift from the regeneration is allowed.

### Seams

- US-002 consumes US-001's repository through `AUDIT_ENTRY_REPOSITORY`. Its unit ACs stub the repository and assert on the captured `create` argument.
- US-003 and US-004 consume US-002's `AUDIT_STORAGE` binding. Their unit ACs stub `IAuditStorage` and assert on the captured `record` argument. Their integration ACs go through the real `PrismaAuditStorage` and assert the stored row.
- US-005 consumes US-001's `PrismaAuditEntryRepository.findPage`. Its unit ACs stub `findPage` and assert on the captured filters.
- US-006 consumes US-005's `AuditLogService.list` and, as a fixture writer, US-003's `AuditRecorder`. Its integration ACs record entries through `app.get(AuditRecorder)` inside `txManager.run` and `withTestActor`, then read them back over HTTP.
- `AuditRecorder` has no production caller in this feature. Its first callers arrive in `permissions-p2-audit-core` (see Out of Scope).

## Acceptance Criteria

### US-001: The `AuditEntry` table and its append-only repository

Repository cases boot `AppModule` and build the repository directly, since no module provides it until US-002: `new PrismaAuditEntryRepository(app.get(TRANSACTION_MANAGER, { strict: false }), app.get(PrismaService, { strict: false }))`. Every call runs inside `withTestActor({ type: 'USER', id: <a user id> }, …)`, since the context-guard rejects a write with no context.

1. [integration] After `applyMigration` of `20261103090000_audit_entry` on a scratch schema from `scratchSchemaBefore(…, '20261103090000_audit_entry')`, the schema has a table `AuditEntry` with the eighteen columns of the model (`id` through `createdAt`).
2. [integration] On that scratch schema, the `AuditEntry` indexes cover exactly `(createdAt)`, `(projectId, createdAt)`, `(actorId, createdAt)`, `(actorType)`, `(approverId)`, `(key)` and `(resourceType, resourceId)`.
3. [integration] `create` with every field except `id` set, followed by `findById` of the returned id, returns a record with a non-empty `id` whose other fields equal the input.
4. [integration] `findPage({ key: 'ticket.create' }, { current: 1, size: 20 })` over rows with keys `ticket.create` and `comment.create` returns exactly the `ticket.create` row.
5. [integration] `findPage({ actorType: 'AGENT', actorId: 'a1' }, …)` over rows by `AGENT/a1`, `USER/a1` and `AGENT/a2` returns exactly the `AGENT/a1` row.
6. [integration] `findPage({ approverId: 'u2' }, …)` over rows with approvers `u2`, `u3` and none returns exactly the `u2` row.
7. [integration] `findPage({ projectId: 'p1' }, …)` over rows with `projectId` `p1`, `p2` and null returns exactly the `p1` row.
8. [integration] `findPage({ resourceType: 'ticket', resourceId: 't1' }, …)` over rows naming `ticket/t1`, `ticket/t2` and `comment/t1` returns exactly the `ticket/t1` row.
9. [integration] `findPage({ from: D1, to: D2 }, …)` over rows created 1 ms before `D1`, at `D1`, between, at `D2` and 1 ms after `D2` returns exactly the rows at `D1`, between and at `D2`.
10. [integration] `findPage({}, …)` over three rows, two with the same `createdAt`, returns them ordered by `createdAt` descending and, for the two equal timestamps, by `id` descending.
11. [integration] `update(<id>, { summary: 'x' })` rejects with `Error` whose message is `audit entries are append-only`.

### US-002: `PrismaAuditStorage` and `AuditLogModule`

Storage cases build `PrismaAuditStorage` with a stub repository that captures its `create` argument. The base entry has `action` `'ticket.create'`, `resource` `'ticket'`, `resourceId` `'t1'`, actor `{ id: 'u1', type: 'USER' }`, `correlationId` `'c1'`, `timestamp` `T` and metadata `{ projectId: 'p1', onBehalfOf: null, origin: 'rest', approval: NO_APPROVAL, summary: null }`.

1. [unit] `record(base)` calls `create` with `key` `'ticket.create'`, `resourceType` `'ticket'`, `resourceId` `'t1'`, `actorType` `'USER'`, `actorId` `'u1'` and `correlationId` `'c1'`.
2. [unit] `record(base)` calls `create` with `createdAt` equal to `T` and `projectId` `'p1'`.
3. [unit] `record` with metadata `onBehalfOf` `{ type: 'AGENT', id: 'a1' }` calls `create` with `onBehalfOfType` `'AGENT'` and `onBehalfOfId` `'a1'`.
4. [unit] `record` with metadata approval `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' }` calls `create` with `requiredMode` `'human'`, `satisfiedBy` `'human'`, `approverType` `'USER'`, `approverId` `'u2'` and `approvalRequestId` `'pa1'`.
5. [unit] `record(base)` calls `create` with `onBehalfOfType`, `onBehalfOfId`, `approverType`, `approverId`, `approvalRequestId` and `summary` all null.
6. [unit] `record` with metadata `summary` `'status OPEN -> CLOSED'` calls `create` with `summary` `'status OPEN -> CLOSED'`.
7. [unit] `record` of the base entry without `actor` rejects with `Error` whose message is `audit entry is not a koda audit entry: actor`.
8. [unit] `record` of the base entry without `correlationId` rejects with `Error` whose message is `audit entry is not a koda audit entry: correlationId`.
9. [unit] `record` of the base entry without `metadata` rejects with `Error` whose message is `audit entry is not a koda audit entry: metadata`.
10. [unit] `record` of the base entry whose metadata lacks `approval` rejects with `Error` whose message is `audit entry is not a koda audit entry: metadata.approval`.
11. [unit] `record` of the base entry whose actor is `{ id: 'u1' }` (no `type`) rejects with `Error` whose message is `audit entry is not a koda audit entry: actor.type`.
12. [unit] `record` of the base entry without `actor` and without `correlationId` rejects with `Error` whose message is `audit entry is not a koda audit entry: actor` (the first missing field in the validation order).
13. [unit] After any of the six rejected `record` calls above, the stub's `create` has not been called.
14. [unit] Compiling `AuditLogModule` with `PrismaService` and `TRANSACTION_MANAGER` mocked resolves `AUDIT_STORAGE` to the module's `PrismaAuditStorage` instance.
15. [unit] In that compiled module, `AUDIT_ENTRY_REPOSITORY` resolves to the module's `PrismaAuditEntryRepository` instance.

### US-003: `AuditRecorder` writes the current context

Unit cases build `AuditRecorder` with a stub `IAuditStorage` that captures its `record` argument and a `TRANSACTION_MANAGER` mock whose `isInTransaction` returns true. The input is `{ key: 'ticket.create', resourceType: 'ticket', resourceId: 't1' }` unless stated otherwise.

1. [unit] Inside `runWithActor({ type: 'USER', id: 'u1' }, …)`, `record` calls `storage.record` with `action` `'ticket.create'`, `resource` `'ticket'` and `resourceId` `'t1'`.
2. [unit] Inside `runWithActor({ type: 'USER', id: 'u1' }, …)`, `record` calls `storage.record` with `actor` `{ id: 'u1', type: 'USER' }`.
3. [unit] Inside `runWithActor({ type: 'USER', id: 'u1' }, …)`, `record` calls `storage.record` with `metadata.origin` `'rest'` and `metadata.onBehalfOf` null.
4. [unit] Inside `runAsSystem('assistant', …, { onBehalfOf: { type: 'AGENT', id: 'a1' } })`, `record` calls `storage.record` with `actor` `{ id: 'assistant', type: 'SYSTEM' }`.
5. [unit] Inside that `runAsSystem` call, `record` calls `storage.record` with `metadata.onBehalfOf` `{ type: 'AGENT', id: 'a1' }`.
6. [unit] Inside `runWithActionContext` with approval `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' }`, `record` calls `storage.record` with that object as `metadata.approval`.
7. [unit] Inside `runWithActionContext` with `correlationId` `'c-7'`, `record` calls `storage.record` with `correlationId` `'c-7'`.
8. [unit] `record` with `projectId` `'p1'` calls `storage.record` with `metadata.projectId` `'p1'`.
9. [unit] `record` without `projectId` calls `storage.record` with `metadata.projectId` null.
10. [unit] `record` with `summary` `'status OPEN -> CLOSED'` calls `storage.record` with `metadata.summary` `'status OPEN -> CLOSED'`.
11. [unit] `record` without `summary` calls `storage.record` with `metadata.summary` null.
12. [unit] `record` with a 600-character `summary` calls `storage.record` with `metadata.summary` equal to the input's first 500 characters.
13. [unit] `record` with a `summary` of exactly 500 characters calls `storage.record` with `metadata.summary` equal to the input unchanged.
14. [unit] `record` calls `storage.record` with a `timestamp` that is a `Date` no earlier than the moment before the call and no later than the moment after it.
15. [integration] In a booted `AppModule`, inside `withTestActor({ type: 'USER', id: <user id> }, …)`, a `txManager.run` that calls `app.get(AuditRecorder).record({ key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId: <project id> })` leaves one `AuditEntry` row whose `actorType` is `'USER'` and whose `actorId` is that user's id.

### US-004: `AuditRecorder` refusals and rollback

Unit cases use the US-003 harness unless stated otherwise.

1. [unit] With no context current, `record` calls `storage.record` with `actor` `{ id: 'unknown', type: 'SYSTEM' }`.
2. [unit] With no context current, `record` calls `storage.record` with `metadata.origin` `'system'`.
3. [unit] With no context current, `record` calls `storage.record` with `metadata.approval` equal to `NO_APPROVAL`.
4. [unit] With no context current, two `record` calls pass two different non-empty `correlationId` strings.
5. [unit] `record({ key: 'no.such.key', resourceType: 'ticket', resourceId: 't1' })` rejects with `Error` whose message is `unknown audit key: no.such.key`.
6. [unit] After that rejection, `storage.record` has not been called.
7. [unit] With `isInTransaction` returning false, `record` rejects with `Error` whose message is `AuditRecorder.record must run inside a transaction`.
8. [unit] After that rejection, `storage.record` has not been called.
9. [unit] When `storage.record` rejects with error `E`, `record` rejects with the same `E`.
10. [integration] In a booted `AppModule`, inside `withTestActor`, a `txManager.run` that calls `record` for resource `ticket/rb-1` and then throws leaves no `AuditEntry` row with `resourceId` `'rb-1'`.
11. [integration] Inside `withTestActor`, a `txManager.run` that creates a label through `fixtureDb(app)` and then calls `record` with key `'no.such.key'` leaves no label with that label's name.
12. [integration] In a booted `AppModule` with the context-guard in `throw` mode, a `txManager.run` entered with no context that calls `record` rejects with `ContextlessWriteError`.

### US-005: `AuditLogService.list` and `AuditEntryDto`

Service cases build `AuditLogService` with a stub repository whose `findPage` captures its filters and returns a one-record page. DTO cases call `AuditEntryDto.from` on a record with every field set unless stated otherwise.

1. [unit] `list({ key: 'ticket.create', actorType: 'AGENT', actorId: 'a1', approverId: 'u2', projectId: 'p1', resourceType: 'ticket', resourceId: 't1' }, { current: 1, size: 20 })` calls `findPage` with those seven filters unchanged.
2. [unit] `list({ from: '2026-10-24' }, …)` calls `findPage` with `from` equal to `new Date('2026-10-24T00:00:00.000Z')`.
3. [unit] `list({ to: '2026-10-24' }, …)` calls `findPage` with `to` equal to `new Date('2026-10-24T23:59:59.999Z')`.
4. [unit] `list({ from: '2026-10-24T10:15:00Z' }, …)` calls `findPage` with `from` equal to `new Date('2026-10-24T10:15:00Z')`.
5. [unit] `list({ from: '2026-10-25', to: '2026-10-24' }, …)` throws `ValidationAppException` whose i18n key is `audit.auditQuery`.
6. [unit] After that throw, `findPage` has not been called.
7. [unit] `list` returns a page whose `records` are the repository records mapped through `AuditEntryDto.from` and whose `total` equals the repository page's `total`.
8. [unit] `AuditEntryDto.from` of a record with `actorType` `'AGENT'` and `actorId` `'a1'` returns `actor` `{ type: 'AGENT', id: 'a1' }`.
9. [unit] `AuditEntryDto.from` of a record with `onBehalfOfType` null returns `onBehalfOf` null.
10. [unit] `AuditEntryDto.from` of a record with `onBehalfOfType` `'USER'` and `onBehalfOfId` `'u1'` returns `onBehalfOf` `{ type: 'USER', id: 'u1' }`.
11. [unit] `AuditEntryDto.from` of a record with `requiredMode` `'none'`, `satisfiedBy` `'none'` and null approver fields returns `approval` `{ requiredMode: 'none', satisfiedBy: 'none', approverType: null, approverId: null, requestId: null }`.
12. [unit] `AuditEntryDto.from` of a record with `requiredMode` `'human'`, `satisfiedBy` `'human'`, `approverType` `'USER'`, `approverId` `'u2'` and `approvalRequestId` `'pa1'` returns `approval` `{ requiredMode: 'human', satisfiedBy: 'human', approverType: 'USER', approverId: 'u2', requestId: 'pa1' }`.
13. [unit] `AuditEntryDto.from` of a record with `createdAt` `new Date('2026-10-24T10:15:00.000Z')` returns `createdAt` `'2026-10-24T10:15:00.000Z'`.

### US-006: `GET /api/audit` for holders of `audit.read`

Integration cases record their entries through `app.get(AuditRecorder)` inside `txManager.run` and `withTestActor`, then call the route over HTTP. The admin is a user holding the seeded global `admin` role.

1. [integration] `GET /api/audit` as the admin returns 200 with a page containing the recorded entry, with its `key`, `resourceType`, `resourceId` and `projectId`.
2. [integration] Of two entries recorded at least 10 ms apart, `GET /api/audit` as the admin returns the later one first.
3. [integration] `GET /api/audit?key=comment.create` as the admin, over entries keyed `ticket.create` and `comment.create`, returns exactly the `comment.create` entries.
4. [integration] `GET /api/audit?projectId=<p1>&from=<D>&to=<D>`, where `<D>` is the UTC date (`YYYY-MM-DD`) computed when the entries are recorded, as the admin over entries in projects `p1` and `p2`, returns exactly the `p1` entries.
5. [integration] `GET /api/audit?actorType=AGENT&actorId=<agent id>` as the admin returns exactly the entries recorded inside `withTestActor({ type: 'AGENT', id: <agent id> }, …)`.
6. [integration] `GET /api/audit` as a user whose only binding is `project-admin` in one project returns 403.
7. [integration] `GET /api/audit` as an agent holding the seeded global `agent` role returns 403.
8. [integration] `GET /api/audit` with no credentials returns 401.
9. [integration] `GET /api/audit?from=2026-10-25&to=2026-10-24` as the admin returns 400 with the message `Invalid audit query: from must not be after to`.
10. [integration] `GET /api/audit?from=yesterday` as the admin returns 400.
11. [integration] `GET /api/audit?from=2026-10-24T10:00:00` (no zone) as the admin returns 400.
12. [integration] `GET /api/audit?from=2026-10-24T10:00:00%2B08:00` (an offset) as the admin returns 400.
13. [integration] `GET /api/audit?actorType=ROBOT` as the admin returns 400.
14. [unit] `PENDING_SURFACE_KEYS.has('audit.read')` is false.
15. [integration] In `endpoint.e2e.spec.ts`, `GET /api/audit` with the suite's admin token returns 200.

Verification note (US-006): `bun run api:export-spec` (repo root) regenerates `openapi.json`. `spec-integrity.integration.spec.ts` checks that the new operation is present and carries tags, a summary and responses. The DB-backed ACs of every story skip inside the nax sandbox (`NAX_SANDBOXED=1`, `.nax/mono/apps/api/context.md`) and are run outside it before the PR.
