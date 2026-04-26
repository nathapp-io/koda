---
paths:
  - "apps/api/*"
---

# API Rules — apps/api

## Read-First
- Follow `nathapp-nestjs-patterns` before implementing NestJS changes
- Prefer Nathapp patterns over generic alternatives when both exist

## Auth
- Use `@nathapp/nestjs-auth` v3; do not use `nestjs-iam`
- API key hashing: deterministic HMAC-SHA256 for lookup
- Password hashing: bcrypt (rounds 12)
- Register `CombinedAuthGuard` globally (`APP_GUARD`); mark public routes with `@IsPublic()`

## Data & Domain
- Soft-delete Projects/Tickets only (`deletedAt`), no hard deletes
- Ticket numbers: allocate with `MAX(number)+1` in Prisma transaction
- Include soft-deleted tickets in numbering; do not reuse numbers
- Do not import enums from `@prisma/client`; use `src/common/enums.ts`
- All ticket transitions must go through `validateTransition()`
- Do not update ticket status directly via Prisma
- Ticket refs use `PROJECT_KEY-NUMBER` format
- Keep workflow constraints centralized in state-machine validation

## Prisma
- Inject `PrismaService<PrismaClient>` from `@nathapp/nestjs-prisma`
- Access client via `this.prisma.client`
- Schema path is `apps/api/prisma/schema.prisma`
- In tests, prefer `createMockPrismaService()` / `createMockPrismaClient()` from `@nathapp/nestjs-prisma`
- Avoid hand-rolled Prisma mock shapes unless there is a specific gap

## Responses & Exceptions
- Controllers return `JsonResponse.Ok<T>(data)`
- Prefer exceptions from `@nathapp/nestjs-common`
- Use app exception classes (`NotFoundAppException`, `ForbiddenAppException`, `AuthException`, `ValidationAppException`) where applicable
- For domain/authz 403, throw `ForbiddenAppException`
- If no app exception equivalent exists, document the exception choice inline

## Swagger
- Controllers require `@ApiTags`, `@ApiBearerAuth`, `@ApiOperation`, `@ApiResponse`
- Response DTO fields must have `@ApiProperty()`

## Testing
- API endpoint changes must be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`
- Keep API lifecycle e2e coverage in this file (do not split)
- Cover happy path and at least one error case per endpoint
- Assert exact status codes
- When mocking DB access in unit/integration tests, use official mock helpers as provider values

## Quality Gates
- `bun run --cwd apps/api lint`
- `bun run --cwd apps/api type-check`
- `cd apps/api && DATABASE_URL=file:./koda-test.db npx jest --forceExit test/e2e`

## i18n
- API translation files: `src/i18n/{en,zh}/*.json`
- Keep one file per module; create in both locales for new modules
- Use keys (for example `this.i18n.t('tickets.notFound')`) instead of hardcoded text

## Implementation Anti-Patterns
- Do not use `@Req() req: any`; use typed request context helpers (for example `@CurrentUser()`)
- Do not pass request-derived actor data through long method chains
- Use constructor injection with typed dependencies (not string DI tokens)
- Return DTO/enveloped responses instead of raw Prisma records
- Use Prisma `err.code` checks, not message string matching
- Do not use `@Optional()` for required dependencies
- Do not throw Nest built-in exceptions for domain auth failures when an App exception exists

## Pagination Anti-Patterns
- Do not write unbounded `do { ... } while (hasMore)` loops without a hard iteration cap. A misbehaving repository, broken cache, or non-pagination-aware mock can cause infinite loops that allocate until OOM
- Do not hardcode the page-size literal in the termination predicate (`length === 100`); reference a `PAGE_SIZE` constant so the predicate cannot drift from the `limit` argument
- Always pair pagination with a `MAX_PAGES` safety bound and a `logger.warn` on overflow — silent infinite loops are worse than a logged early exit
- Prefer `data.length >= PAGE_SIZE` over `data.length === PAGE_SIZE` so a repository overshoot still terminates
- Wrong:
  ```ts
  do {
    const result = await this.repo.findByProject({ page, limit: 100 });
    hasMore = result.data.length === 100;
    page++;
  } while (hasMore);
  ```
- Correct:
  ```ts
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10_000;
  do {
    if (page > MAX_PAGES) {
      this.logger.warn(`pagination exceeded ${MAX_PAGES} pages for ${projectId}`);
      break;
    }
    const result = await this.repo.findByProject({ page, limit: PAGE_SIZE });
    hasMore = result.data.length >= PAGE_SIZE;
    page++;
  } while (hasMore);
  ```

## Testing Anti-Patterns
- Do not create `Test.createTestingModule(...).compile()` inline inside `it(...)` bodies without `beforeEach`/`afterEach` cleanup. NestJS DI containers retain reflector metadata, module compiler caches, and injector graphs even after the test returns; ~30+ uncleaned modules per file is enough to OOM Jest
- If a service has only constructor-injected dependencies and no Nest lifecycle (no `OnModuleInit`, no decorator metadata under test), prefer **direct instantiation** (`new ServiceClass(mockDep)`) over `Test.createTestingModule`. It is faster, allocates orders of magnitude less, and avoids the cleanup requirement entirely
- If `Test.createTestingModule` is genuinely needed, store the module and close it: declare `let module: TestingModule` at `describe` scope, assign in `beforeEach`/`beforeAll`, and `await module.close()` in the matching `afterEach`/`afterAll`
- Do not stub paginated repository methods with `mockResolvedValue(items)` when `items.length >= PAGE_SIZE`. The mock will return the same full page on every call regardless of `skip`, and the production loop will never terminate. Use a pagination-aware `mockImplementation` that honors `skip`:
  ```ts
  // Wrong — infinite loop in production code under test
  mockClient.memoryItem.findMany.mockResolvedValue(items);   // items.length === 100
  
  // Correct — page 1 returns items, subsequent pages return []
  mockClient.memoryItem.findMany.mockImplementation((opts: any) =>
    Promise.resolve(opts?.skip === 0 ? items : []),
  );
  ```
- Do not let acceptance/test files grow past ~1000 lines. Long files compound the cost of any per-test allocation pattern (DI containers, large mock arrays) until the suite hits OOM. Split by feature area when over the limit

## Quick Reference
- Wrong: `@Inject('PrismaService') private prisma: PrismaService`
- Correct: constructor injection with typed `PrismaService`
- Wrong: return raw Prisma result from controller
- Correct: map to DTO and wrap with `JsonResponse.Ok(...)`
