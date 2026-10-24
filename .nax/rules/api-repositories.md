---
description: "API repositories: AbstractPrismaRepository implementation, private DI tokens, filtered query escape hatches"
paths:
  - "apps/api/*"
appliesTo:
  - "**/*.repository.ts"
  - "**/*.module.ts"
priority: 80
---

# API Repository Implementation — apps/api

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

