---
paths:
  - "apps/api/*"
priority: 80
---

# API Testing — apps/api

> Always-on for apps/api stories. Rules about how to write tests cannot be `appliesTo:`-filtered against test-file globs — the test files are produced by the agent, not declared upfront in `contextFiles`.

## Testing
- API endpoint changes must be reflected in `test/e2e/api-endpoint/endpoint.e2e.spec.ts`
- Keep API lifecycle e2e coverage in this file (do not split)
- Cover happy path and at least one error case per endpoint
- Assert exact status codes
- When mocking DB access in unit/integration tests, use official mock helpers as provider values

## Module Registration / DI Tests
- Module-compilation and dependency-injection wiring tests are **unit tests**, never integration tests
- Co-locate them as `src/<feature>/<feature>.module.spec.ts` so they run under `bun run test` (which executes without a database)
- Do NOT place them under `test/integration/` and do NOT put `integration` in the filename — the default `test` script excludes any path matching `integration`, so wiring failures hidden there are not caught until the (less frequently run, DB-dependent) integration suite
- These tests must not require a database: `Test.createTestingModule({ imports: [FeatureModule] }).compile()` with external collaborators (`PrismaService`, `TRANSACTION_MANAGER`, `ConfigService`) mocked via provider `useValue`
- `test/integration/` is reserved for DB-backed behavior only: repository round-trips, constraints, soft-delete semantics, transactions
- Prefer a shared test harness that wires the common global stub providers so module specs stay short and do not drift

## Controller Coverage
- Controller-level fallback paths (event-type detection, header absence, unknown payload routing) need integration or e2e coverage — service unit tests alone are insufficient

## Testing Anti-Patterns
- Do not create `Test.createTestingModule(...).compile()` inline inside `it(...)` bodies without `beforeEach`/`afterEach` cleanup. NestJS DI containers retain reflector metadata, module compiler caches, and injector graphs even after the test returns; ~30+ uncleaned modules per file is enough to OOM Jest
- If a service has only constructor-injected dependencies and no Nest lifecycle (no `OnModuleInit`, no decorator metadata under test), prefer **direct instantiation** (`new ServiceClass(mockDep)`) over `Test.createTestingModule`. It is faster, allocates orders of magnitude less, and avoids the cleanup requirement entirely
- If `Test.createTestingModule` is genuinely needed, store the module and close it: declare `let module: TestingModule` at `describe` scope, assign in `beforeEach`/`beforeAll`, and `await module.close()` in the matching `afterEach`/`afterAll`
- Do not stub paginated repository methods with `mockResolvedValue(items)` when `items.length >= PAGE_SIZE`; use a pagination-aware `mockImplementation` that honors `skip`
- Do not let acceptance/test files grow past ~1000 lines. Long files compound the cost of any per-test allocation pattern (DI containers, large mock arrays) until the suite hits OOM. Split by feature area when over the limit
