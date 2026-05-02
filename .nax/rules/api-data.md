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
// ✅ Correct
await this.txManager.run(async () => {
  await this.prisma.client.ticket.update({ where: { id }, data: { status } });
  await this.prisma.client.ticketActivity.create({ data: { ... } });
});

// ❌ Banned — don't thread tx explicitly
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

## PrismaService — Direct Injection (Non-Repository Code)
- Inject `PrismaService` (without generic) for non-repository code (auth, RAG, VCS webhook, outbox) unless the file is already migrated to a repository
- Access the client via `this.prisma.client` — never cast to `PrismaClient` or a custom interface
- Do NOT write `private get db() { return this.prisma.client as unknown as T; }` — this defeats the transparent proxy

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

## Pagination Anti-Patterns
- Do not write unbounded `do { ... } while (hasMore)` loops without a hard iteration cap
- Do not hardcode the page-size literal in the termination predicate (`length === 100`); reference a `PAGE_SIZE` constant
- Always pair pagination with a `MAX_PAGES` safety bound and a `logger.warn` on overflow
- Prefer `data.length >= PAGE_SIZE` over `data.length === PAGE_SIZE`
