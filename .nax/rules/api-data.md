---
paths:
  - "apps/api/*"
appliesTo:
  - "**/*.service.ts"
  - "**/*.repository.ts"
  - "**/tickets/**"
  - "**/projects/**"
  - "**/prisma/**"
priority: 80
---

# API Data & Persistence — apps/api

## Data & Domain
- Soft-delete Projects/Tickets only (`deletedAt`), no hard deletes
- Ticket numbers: allocate with `MAX(number)+1` inside `txManager.run()` — never outside a transaction
- Include soft-deleted tickets in numbering; do not reuse numbers
- All ticket transitions must go through `validateTransition()`
- Do not update ticket status directly via Prisma
- Ticket refs use `PROJECT_KEY-NUMBER` format
- Keep workflow constraints centralized in state-machine validation

## Layering & Boundaries (repository → service → public)

Data flows **repository → service → public**, and each layer only talks to the one directly below it:

- **Repository** — module-internal. Owns all Prisma access and all Prisma-to-domain mapping. Returns domain types, never raw Prisma models. Lives behind a `*_REPOSITORY` token used only inside its own module.
- **Service** — the module's public face. Orchestrates repositories, applies business rules, returns domain types or DTOs. The only provider a module exports.
- **Public (controllers + other modules)** — depend on services only.

### `@prisma/client` is confined to the repository layer
- Import Prisma model/client types (`PrismaClient`, `Project`, `Ticket`, …) **only** in `*.repository.ts` and persistence-mapping / domain files
- **Banned** in controllers, DTOs, service *public* method signatures, and any other module
- A controller that imports from `@prisma/client` is always a violation — route the data through a service that returns a DTO/domain type

```typescript
// Banned: controller leaking a Prisma model to the HTTP boundary
import { Project } from '@prisma/client';
@Get() list(): Promise<Project[]> { /* ... */ }

// Correct: controller depends on a service that returns a DTO/domain type
@Get() async list(): Promise<JsonResponse<ProjectDto[]>> {
  return JsonResponse.Ok(await this.projects.list());
}
```

### Repositories are module-private — never exported
- A repository class or its `*_REPOSITORY` token MUST NOT appear in a module's `exports:`. Neither must `PrismaService`
- Export **services** only — that is the module's entire public contract
- `memory.module.ts` is the reference: `MEMORY_ITEM_REPOSITORY` is defined and consumed only inside the module and never exported

```typescript
// Banned: vcs.module.ts leaks a repository token to other modules
exports: [VCS_REPOSITORY, VcsConnectionService, /* ... */]
// Correct: export services only
exports: [VcsConnectionService, VcsSyncService, /* ... */]
```

### Controllers and cross-module callers use services, not repositories
- Never inject a repository or `PrismaService` into a controller
- A module that needs another module's data calls that module's **service**, never its repository or Prisma directly
- Service public methods return domain types or DTOs — never Prisma model types or `PrismaClient`

### Migration carve-out (legacy direct-Prisma code)
- Much existing code (auth, RAG, events, tickets/projects/labels services, webhooks, monitoring, …) injects `PrismaService` directly because it predates the repository pattern. This is **tolerated legacy**, not a template
- **New** services and modules MUST follow repository → service → public
- When you touch a legacy file for substantive work, prefer extracting a repository over extending the direct-Prisma usage
- Even in legacy modules, do **not** add `@prisma/client` imports to controllers

## Prisma Module Setup
- `PrismaModule.forRoot` MUST include `transaction: true` — this activates `TRANSACTION_MANAGER` and the transparent proxy on `PrismaService.client`
- Without `transaction: true`, `@Inject(TRANSACTION_MANAGER)` will throw at startup

```typescript
PrismaModule.forRoot({
  isGlobal: true,
  client: PrismaClient,
  transaction: true,  // required
}),
```

## Transactions — Use txManager.run(), not $transaction
- Inject `@Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager` from `@nathapp/nestjs-data`
- Wrap all multi-write operations in `txManager.run(async () => { ... })`
- Inside `txManager.run()`, use `this.prisma.client.xxx` as normal — the transparent proxy routes calls to the active transaction automatically
- **Never** pass a `tx` argument or use `$transaction(async tx => { tx.model... })` — this pattern is banned

```typescript
// Correct
await this.txManager.run(async () => {
  await this.prisma.client.ticket.update({ where: { id }, data: { status } });
  await this.prisma.client.ticketActivity.create({ data: { ... } });
});

// Banned — don't thread tx explicitly
await this.prisma.client.$transaction(async (tx) => {
  await tx.ticket.update({ ... });
  await tx.ticketActivity.create({ ... });
});
```

- Exception: use `this.prisma.withTransaction(callback, { isolationLevel: 'Serializable' })` when you need explicit transaction options (isolation level, timeout). This is the only valid use of the manual transaction pattern.

## Repositories — Use AbstractPrismaRepository
- New repositories MUST extend `AbstractPrismaRepository<TDomain, TModel, TId>` from `@nathapp/nestjs-prisma`
- `TDomain` is a plain interface owned by the service layer, never a Prisma-generated type
- Implement four required members: `modelDelegate(client)`, `toDomain(m)`, `toPersistenceCreate(d)`, `toPersistenceUpdate(p)`
- Inject `@Inject(TRANSACTION_MANAGER) tx: ITransactionManager` and pass it to `super(tx)`
- Inject `PrismaService` as a second constructor arg for escape-hatch methods

```typescript
@Injectable()
export class PrismaFooRepository
  extends AbstractPrismaRepository<FooDomain, FooModel, string> {
  constructor(
    @Inject(TRANSACTION_MANAGER) tx: ITransactionManager,
    private readonly prisma: PrismaService,
  ) {
    super(tx);
  }

  protected modelDelegate(client: unknown) {
    return (client as Record<string, unknown>).foo;
  }
  protected toDomain(m: FooModel): FooDomain { /* map fields */ }
  protected toPersistenceCreate(d: FooDomain) { /* map fields */ }
  protected toPersistenceUpdate(p: Partial<FooDomain>) { /* return partial map */ }
}
```

## IRepository Tokens — Wire Behind DI Token
- Every repository class MUST be registered behind a symbol DI token in its module
- Services depend on the abstract `IRepository<TDomain>` token, not the concrete class
- Only inject the concrete class directly when you need escape-hatch methods (ORM-specific queries)

```typescript
// In the module providers:
PrismaFooRepository,
{ provide: FOO_REPOSITORY, useExisting: PrismaFooRepository },

// In the service constructor:
@Inject(FOO_REPOSITORY) private readonly foos: IRepository<FooDomain>,
private readonly fooPrismaRepo: PrismaFooRepository,  // only if escape hatches needed
```

## Escape Hatches — When NOT to Use IRepository
- `IRepository.findAll(page)` is paginated and unfiltered; add a custom method on the concrete repo for filtered list queries
- Inject the concrete repo class directly when you need `include`, complex `where`, `orderBy`, raw SQL, or stored procedures
- Mixing portable (`IRepository`) and concrete injections in the same service is fine

```typescript
// Escape hatch on the concrete repo:
async findByTicketId(ticketId: string): Promise<CommentDomain[]> {
  const models = await this.prisma.client.comment.findMany({
    where: { ticketId },
    orderBy: { createdAt: 'asc' },
  });
  return (models as Comment[]).map((m) => this.toDomain(m));
}
```

## PrismaService — Direct Injection (legacy carve-out only)
- Direct `PrismaService` injection outside a repository is **legacy** — see the migration carve-out under [Layering & Boundaries](#layering--boundaries-repository--service--public). Do not introduce it in new services or modules
- Where it already exists: access the client via `this.prisma.client` — never cast to `PrismaClient` or a custom interface
- Do NOT write `private get db() { return this.prisma.client as unknown as T; }` — this defeats the transparent proxy and re-leaks Prisma types

## Unsafe Casts — Banned
- Do not cast `this.prisma.client as unknown as PrismaClient`
- Do not define custom `ExtendedPrismaClient` or `PrismaDelegate` interfaces to work around type gaps
- If Prisma types are incomplete, use `(client as Record<string, unknown>).modelName` in the repository's `modelDelegate`

## Testing
- In tests, prefer `createMockPrismaService()` / `createMockPrismaClient()` from `@nathapp/nestjs-prisma`
- Mock `TRANSACTION_MANAGER` as `{ run: jest.fn(fn => fn()), getClient: jest.fn(), isInTransaction: jest.fn(() => false) }`
- The `run` mock MUST call the callback immediately — this makes the transaction a no-op in unit tests while still exercising the service logic
- Mock `IRepository<TDomain>` by providing a plain object with jest.fn() on all methods, or use `createMock<IRepository<TDomain>>()` from `@golevelup/ts-jest`
- Provide `TRANSACTION_MANAGER` in every test module that uses a service which injects it

```typescript
// Standard txManager mock:
const mockTxManager = {
  run: jest.fn((fn: () => Promise<unknown>) => fn()),
  getClient: jest.fn(),
  isInTransaction: jest.fn(() => false),
};

// In beforeEach providers:
{ provide: TRANSACTION_MANAGER, useValue: mockTxManager },
```

## Schema Hygiene
- Before writing any `prisma.client.<model>.*` call or repository, verify the model exists in `apps/api/prisma/schema.prisma`
- If the model is missing, add it to the schema and run `bun run db:migrate` + `bun run db:generate` before implementing the service or repository layer
- Never reference a Prisma model in code and defer schema work to a follow-up — missing models cause runtime errors that TypeScript cannot catch until after client regeneration
- Before writing a filtered `findMany`/`findFirst` on a field, verify `@@index` covers that field in schema.prisma; a missing index causes a full table scan

## Pagination Anti-Patterns
- Do not write unbounded `do { ... } while (hasMore)` loops without a hard iteration cap
- Do not hardcode the page-size literal in the termination predicate (`length === 100`); reference a `PAGE_SIZE` constant
- Always pair pagination with a `MAX_PAGES` safety bound and a `logger.warn` on overflow
- Prefer `data.length >= PAGE_SIZE` over `data.length === PAGE_SIZE`
- Every `findMany` on an unbounded table must include `take`; never issue a bare `findMany` that returns all rows

## Query Guard Pattern
- When an early return guards a conditional block, all downstream filters that depend on that condition must be INSIDE the guard — not after it. A filter placed after an early return is silently skipped when the condition is absent.
